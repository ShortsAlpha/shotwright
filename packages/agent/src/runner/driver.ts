/**
 * RunnerDriver: DeviceDriver over ShotwrightRunner's HTTP API (ios/ShotwrightRunner/README.md).
 *
 * Readiness rules from docs/spikes/simulator.md and docs/spikes/explorer.md:
 * - launch with `simctl launch` (fails fast) after pressing Home (no "◀ App" back-link), never the
 *   runner's `/launch` right after an install;
 * - after a launch, first wait (with the runner's cheap `/frame` thumbnails, which never touch the
 *   app's accessibility tree) until the app shows a non-blank picture that stays the same for 1 s,
 *   and only then ask for `/source`. A snapshot requested while a just-launched app is still
 *   loading blocks the runner for 10-60 s; requested once the picture is stable it takes ~1 s;
 * - after an action, poll `/source` until two consecutive snapshots have the same layout;
 * - every request has its own timeout. When one times out, `/health` tells "busy" from "hung": the
 *   runner answers it from its HTTP queue with the route that holds the main thread. A busy runner
 *   is waited for (up to `timeouts.busy`); one that does not answer at all is restarted (`onHang`).
 *   Idempotent reads are retried once; actions throw RunnerRestartedError after a restart so the
 *   caller observes the screen again before acting.
 * - Selectors: the flow schema's `index` (position among same-type siblings) and `frame` are not
 *   the runner's `index` (n-th match of the whole query), so they are never forwarded. Use
 *   `RunnerSelector.nth` for the runner's meaning.
 */
import type {
  DeviceDriver,
  ElementSelector,
  LaunchOptions,
  Point,
  Rect,
  ScreenInfo,
  SwipeGesture,
  TapTarget,
  UINode,
  UISnapshot,
} from "@shotwright/core";
import { RunnerError, RunnerRestartedError, RunnerTimeoutError } from "./errors.ts";
import { RunnerHttp } from "./http.ts";
import { launchApp, terminateApp } from "./simctl.ts";
import { contentShare, layoutHash, sameFrame, type Frame, type SettleOptions } from "./stable.ts";

/**
 * ElementSelector plus the runner's own disambiguator. `nth` is the runner's `index`: the n-th
 * match of the whole query (0-based). The flow schema's `index` (position among same-type
 * siblings) and `frame` are ignored here: the runner cannot honour them.
 */
export type RunnerSelector = ElementSelector & { readonly nth?: number };

export interface RunnerTimeouts {
  readonly health: number;
  readonly source: number;
  readonly screenshot: number;
  readonly tap: number;
  readonly swipe: number;
  readonly type: number;
  readonly home: number;
  readonly launch: number;
  readonly frame: number;
  /** How long `/health` may stay silent after a timed-out request before the runner counts as hung. */
  readonly hangCheck: number;
  /**
   * How long to wait for a runner that answers `/health` but is still busy with a timed-out
   * request (XCTest waits up to 60 s for a just-launched app to register) before restarting it.
   */
  readonly busy: number;
}

export const DEFAULT_TIMEOUTS: RunnerTimeouts = {
  health: 3_000,
  // The first /source after a launch waits until the app is idle (up to ~10 s on this machine).
  source: 30_000,
  screenshot: 10_000,
  // Identifier taps fall back to an XCUI query that can take 2-10 s.
  tap: 20_000,
  swipe: 15_000,
  type: 30_000,
  home: 10_000,
  launch: 90_000,
  frame: 10_000,
  // An older runner serves /health behind a slow call; the current one answers it at once.
  hangCheck: 15_000,
  busy: 90_000,
};

/** Times of the last launch, in ms from the start of `launch()`. */
export type LaunchReadiness = "source-first" | "frames-first" | "layout";

export interface LaunchTiming {
  readonly bundleId: string;
  readonly mode: LaunchReadiness;
  /** `simctl launch` returned (after Home). */
  readonly launchedMs: number;
  /** The picture was non-blank and unchanged for `minStableMs` (undefined: old runner without `/frame`). */
  readonly visibleMs?: number;
  /** A blank but stable picture was accepted after `blankAcceptMs`. */
  readonly blank?: boolean;
  /** The first `/source` answered. */
  readonly firstSourceMs: number;
  /** The layout was stable. */
  readonly stableMs: number;
  readonly stable: boolean;
}

export interface VisibleOptions {
  readonly bundleId?: string;
  /** Default 45 s. */
  readonly timeoutMs?: number;
  /** The picture must stay the same this long. Default 1000 ms (a splash screen changes sooner). */
  readonly minStableMs?: number;
  /** Accept a blank but unchanged picture after this long. Default 12 s. */
  readonly blankAcceptMs?: number;
  readonly intervalMs?: number;
}

export interface VisibleResult {
  readonly visible: boolean;
  readonly blank: boolean;
  readonly waitedMs: number;
  readonly frames: number;
  readonly state?: string;
}

export type StableSnapshot = UISnapshot & {
  readonly stable: boolean;
  readonly waitedMs: number;
  /** When the first `/source` of this wait answered (ms from its start). */
  readonly firstMs?: number;
};

export interface RunnerDriverOptions {
  readonly udid: string;
  readonly port?: number;
  readonly host?: string;
  readonly timeouts?: Partial<RunnerTimeouts>;
  /** Called once when the runner is hung; should restart it and resolve when `/health` answers again. */
  readonly onHang?: () => Promise<void>;
  /** Wait for a stable layout after tap/swipe/type. Default true. Launch always waits. */
  readonly settleAfterActions?: boolean;
  readonly settle?: SettleOptions;
  /**
   * How `launch()` decides the app is ready:
   * - "source-first" (default): `/source` at once (it answers when the app can), then a stable
   *   non-blank picture (`/frame`) and a second, equal layout;
   * - "frames-first": a stable non-blank picture first, then two equal layouts;
   * - "layout": two equal layouts at least 1.5 s apart (the original rule).
   */
  readonly launchReadiness?: LaunchReadiness;
  readonly log?: (message: string) => void;
}

export interface HealthResponse {
  currentBundleId?: string;
  screen?: { w: number; h: number };
  /** Set while a request holds the runner's main thread (the answer then comes from cached values). */
  busy?: { route: string; ms: number; queued: number };
  cached?: boolean;
}

interface SourceResponse {
  bundleId: string;
  state: string;
  count: number;
  tree: UINode;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isPoint(target: TapTarget): target is Point {
  return typeof (target as Point).x === "number" && typeof (target as Point).y === "number";
}

/** Runner body for a selector: identifier, label, type, and `nth` as the runner's `index`. Never the flow's `index`/`frame`. */
function selectorBody(selector: RunnerSelector | undefined): Record<string, unknown> {
  if (!selector) return {};
  const body: Record<string, unknown> = {};
  if (selector.id !== undefined) body.identifier = selector.id;
  if (selector.label !== undefined) body.label = selector.label;
  if (selector.type !== undefined) body.type = selector.type;
  if (selector.nth !== undefined) body.index = selector.nth;
  return body;
}

/** Frame of the `nth` node (default the first) matching id, label and type, depth-first. */
export function findFrame(tree: UINode, selector: RunnerSelector): Rect | undefined {
  let remaining = selector.nth ?? 0;
  let found: Rect | undefined;
  const walk = (node: UINode): boolean => {
    const matches =
      (selector.id === undefined || node.identifier === selector.id) &&
      (selector.label === undefined || node.label === selector.label) &&
      (selector.type === undefined || node.type === selector.type) &&
      node.frame.w > 0 &&
      node.frame.h > 0;
    if (matches) {
      if (remaining === 0) {
        found = node.frame;
        return true;
      }
      remaining--;
    }
    return (node.children ?? []).some(walk);
  };
  walk(tree);
  return found;
}

export class RunnerDriver implements DeviceDriver {
  readonly udid: string;
  readonly http: RunnerHttp;
  readonly timeouts: RunnerTimeouts;
  /** Target of source/tap/type when the call names no bundle id: the last launched app. */
  currentBundleId: string | undefined;
  /** Timing of the last `launch()`. */
  lastLaunch: LaunchTiming | undefined;

  readonly #onHang: (() => Promise<void>) | undefined;
  readonly #settleAfterActions: boolean;
  readonly #settle: SettleOptions;
  readonly #launchReadiness: LaunchReadiness;
  readonly #log: (message: string) => void;
  #restarting: Promise<void> | undefined;
  #screen: ScreenInfo | undefined;
  #lastStable: { snapshot: StableSnapshot; at: number } | undefined;
  /** False once the runner answered 404 for `/frame` (a runner built before the route existed). */
  #hasFrame = true;

  constructor(options: RunnerDriverOptions) {
    this.udid = options.udid;
    this.http = new RunnerHttp(options.port ?? 8615, options.host ?? "127.0.0.1");
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.#onHang = options.onHang;
    this.#settleAfterActions = options.settleAfterActions ?? true;
    this.#settle = options.settle ?? {};
    this.#launchReadiness = options.launchReadiness ?? "source-first";
    this.#log = options.log ?? (() => undefined);
  }

  // --- DeviceDriver -----------------------------------------------------------

  async screen(): Promise<ScreenInfo> {
    const health = await this.health();
    const screen: ScreenInfo = {
      width: health.screen?.w ?? 0,
      height: health.screen?.h ?? 0,
      ...(health.currentBundleId ? { currentBundleId: health.currentBundleId } : {}),
    };
    if (screen.width > 0) this.#screen = screen;
    return screen;
  }

  async launch(options: LaunchOptions): Promise<void> {
    this.#lastStable = undefined;
    const started = Date.now();
    const bundleId = options.bundleId;
    // Home first: launching while another app is in front adds a "◀ App" back-link to the status bar.
    await this.home().catch((error: unknown) => this.#log(`home before launch failed: ${String(error)}`));
    await launchApp(this.udid, bundleId, options.args ?? [], options.env ?? {});
    this.currentBundleId = bundleId;
    const launchedMs = Date.now() - started;
    const mode = this.#launchReadiness;

    let visible: VisibleResult | undefined;
    let visibleAt: number | undefined;
    let firstSourceMs: number;
    let snapshot: StableSnapshot;
    if (mode === "frames-first") {
      // A stable, non-blank picture first (cheap /frame calls), then two equal layouts.
      visible = await this.waitForVisible({ bundleId });
      visibleAt = visible ? Date.now() - started : undefined;
      snapshot = await this.waitForStable({ bundleId, minStableMs: visible?.visible ? 0 : 1500, timeoutMs: 30_000 });
      firstSourceMs = (visibleAt ?? launchedMs) + (snapshot.firstMs ?? snapshot.waitedMs);
    } else if (mode === "source-first" && this.#hasFrame) {
      // Ask for the layout at once: the request starts XCTest's attach to the new process while the
      // app is still loading, and answers as soon as the app can (it holds the runner meanwhile;
      // /health still answers, so this is not mistaken for a hang). Then confirm with a stable
      // non-blank picture and a second, equal layout instead of a fixed 1.5 s window.
      let first = await this.#firstSource(bundleId, 90_000);
      firstSourceMs = Date.now() - started;
      const deadline = Date.now() + 30_000;
      let stable = false;
      for (;;) {
        visible = await this.waitForVisible({ bundleId, minStableMs: 500, blankAcceptMs: 8_000, timeoutMs: Math.max(1_000, deadline - Date.now()) });
        visibleAt ??= Date.now() - started;
        if (!visible) {
          // A runner without /frame: the old rule.
          const settled = await this.waitForStable({ bundleId, minStableMs: 1500, timeoutMs: 30_000 });
          first = settled;
          stable = settled.stable;
          break;
        }
        const next = await this.source(bundleId);
        if (layoutHash(next.tree) === layoutHash(first.tree)) {
          first = next;
          stable = true;
          break;
        }
        first = next;
        if (Date.now() > deadline) {
          this.#log("layout did not settle within 30 s after the launch; using the last snapshot");
          break;
        }
      }
      snapshot = { ...first, stable, waitedMs: Date.now() - started - launchedMs };
      this.#lastStable = { snapshot, at: Date.now() };
    } else {
      // The original rule: two equal layouts at least 1.5 s apart (a splash screen changes sooner).
      snapshot = await this.waitForStable({ bundleId, minStableMs: 1500, timeoutMs: 30_000 });
      firstSourceMs = launchedMs + (snapshot.firstMs ?? snapshot.waitedMs);
    }
    const stableMs = Date.now() - started;
    this.lastLaunch = {
      bundleId,
      mode,
      launchedMs,
      ...(visibleAt !== undefined ? { visibleMs: visibleAt } : {}),
      ...(visible?.blank ? { blank: true } : {}),
      firstSourceMs,
      stableMs,
      stable: snapshot.stable,
    };
    this.#log(
      `launched ${bundleId} (${mode}): simctl ${launchedMs} ms, first /source at ${firstSourceMs} ms, ` +
        (visibleAt !== undefined ? `${visible?.visible ? (visible.blank ? "blank but stable" : "stable picture") : "picture not stable"} at ${visibleAt} ms, ` : "") +
        `${snapshot.stable ? "stable" : "unstable"} layout at ${stableMs} ms`,
    );
  }

  /** The first `/source` after a launch: retried while the app is not running yet, with a long timeout. */
  async #firstSource(bundleId: string, timeoutMs: number): Promise<UISnapshot> {
    const deadline = Date.now() + timeoutMs;
    const path = `/source?bundleId=${encodeURIComponent(bundleId)}`;
    for (;;) {
      try {
        const r = await this.#request("/source", () => this.http.json<SourceResponse>("GET", path, undefined, Math.max(5_000, deadline - Date.now())), true);
        return { bundleId: r.bundleId, state: r.state, count: r.count, tree: r.tree };
      } catch (error) {
        if (error instanceof RunnerRestartedError || Date.now() > deadline) throw error;
        // "<bundle> is not running" right after simctl launch: keep asking.
        await sleep(300);
      }
    }
  }

  /** XCUIApplication.launch() through the runner. Slower and can block after an install; prefer launch(). */
  async launchViaRunner(options: LaunchOptions & { activate?: boolean }): Promise<void> {
    this.#lastStable = undefined;
    await this.#request(
      "/launch",
      () =>
        this.http.json("POST", "/launch", {
          bundleId: options.bundleId,
          args: options.args ?? [],
          env: options.env ?? {},
          activate: options.activate ?? false,
        }, this.timeouts.launch),
      false,
    );
    this.currentBundleId = options.bundleId;
    await this.waitForStable({ bundleId: options.bundleId, minStableMs: 1500, timeoutMs: 30_000 });
  }

  async terminate(bundleId?: string): Promise<void> {
    this.#lastStable = undefined;
    const id = bundleId ?? this.currentBundleId;
    if (id) await terminateApp(this.udid, id);
  }

  async home(): Promise<void> {
    this.#lastStable = undefined;
    await this.#request("/home", () => this.http.json("POST", "/home", {}, this.timeouts.home), true);
  }

  async source(bundleId?: string): Promise<UISnapshot> {
    const id = bundleId ?? this.currentBundleId;
    const path = id ? `/source?bundleId=${encodeURIComponent(id)}` : "/source";
    const r = await this.#request("/source", () => this.http.json<SourceResponse>("GET", path, undefined, this.timeouts.source), true);
    return { bundleId: r.bundleId, state: r.state, count: r.count, tree: r.tree };
  }

  async screenshot(): Promise<Uint8Array> {
    return this.#request("/screenshot", () => this.http.bytes("/screenshot", this.timeouts.screenshot), true);
  }

  async tap(target: TapTarget): Promise<void> {
    this.#lastStable = undefined;
    const body = isPoint(target)
      ? { x: target.x, y: target.y }
      : { ...selectorBody(target as RunnerSelector), ...(this.currentBundleId ? { bundleId: this.currentBundleId } : {}) };
    await this.#request("/tap", () => this.http.json("POST", "/tap", body, this.timeouts.tap), false);
    await this.#afterAction();
  }

  /**
   * Coordinate swipes stop momentum at the end (`hold`), so a replay scrolls exactly as far as the
   * exploration did. Direction swipes become a coordinate swipe over half the screen (or the
   * `within` element), centred.
   */
  async swipe(gesture: SwipeGesture): Promise<void> {
    this.#lastStable = undefined;
    let from: Point;
    let to: Point;
    let durationMs = 300;
    if ("from" in gesture) {
      from = gesture.from;
      to = gesture.to;
      durationMs = gesture.durationMs ?? durationMs;
    } else {
      const area = await this.#area(gesture.within);
      const cx = area.x + area.w / 2;
      const cy = area.y + area.h / 2;
      const dx = area.w * 0.25;
      const dy = area.h * 0.25;
      const vectors = {
        up: [{ x: cx, y: cy + dy }, { x: cx, y: cy - dy }],
        down: [{ x: cx, y: cy - dy }, { x: cx, y: cy + dy }],
        left: [{ x: cx + dx, y: cy }, { x: cx - dx, y: cy }],
        right: [{ x: cx - dx, y: cy }, { x: cx + dx, y: cy }],
      } as const;
      [from, to] = vectors[gesture.direction];
    }
    const body = { x1: from.x, y1: from.y, x2: to.x, y2: to.y, duration: durationMs / 1000, hold: 0.2 };
    await this.#request("/swipe", () => this.http.json("POST", "/swipe", body, this.timeouts.swipe), false);
    await this.#afterAction();
  }

  async typeText(text: string, into?: ElementSelector): Promise<void> {
    this.#lastStable = undefined;
    const body = {
      text,
      ...selectorBody(into as RunnerSelector | undefined),
      ...(this.currentBundleId ? { bundleId: this.currentBundleId } : {}),
    };
    await this.#request("/type", () => this.http.json("POST", "/type", body, this.timeouts.type), false);
    await this.#afterAction();
  }

  // --- Extras -------------------------------------------------------------------

  async health(timeoutMs = this.timeouts.health): Promise<HealthResponse> {
    return this.http.json<HealthResponse>("GET", "/health", undefined, timeoutMs);
  }

  /**
   * A grayscale thumbnail of the screen and the app's state (`GET /frame`). Cheap and never blocked
   * by the app: the picture comes from the system, not the accessibility tree. Undefined when the
   * runner predates the route.
   */
  async frame(bundleId?: string, size: { w: number; h: number } = { w: 72, h: 156 }): Promise<Frame | undefined> {
    if (!this.#hasFrame) return undefined;
    const id = bundleId ?? this.currentBundleId;
    const query = `w=${size.w}&h=${size.h}${id ? `&bundleId=${encodeURIComponent(id)}` : ""}`;
    try {
      const r = await this.#request(
        "/frame",
        () => this.http.json<{ w: number; h: number; gray: string; state?: string }>("GET", `/frame?${query}`, undefined, this.timeouts.frame),
        true,
      );
      return { w: r.w, h: r.h, gray: new Uint8Array(Buffer.from(r.gray, "base64")), ...(r.state ? { state: r.state } : {}) };
    } catch (error) {
      if (error instanceof RunnerError && error.status === 404) {
        this.#hasFrame = false;
        this.#log("this runner has no /frame route; launch readiness falls back to layout stability");
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Waits until the app is in the foreground and its picture is non-blank and unchanged for
   * `minStableMs` (a blank picture is accepted after `blankAcceptMs`). Uses `/frame` only, so the
   * runner stays free while the app loads. Undefined when the runner has no `/frame`.
   */
  async waitForVisible(options: VisibleOptions = {}): Promise<VisibleResult | undefined> {
    const timeoutMs = options.timeoutMs ?? 45_000;
    const minStableMs = options.minStableMs ?? 1_000;
    const blankAcceptMs = options.blankAcceptMs ?? 12_000;
    const intervalMs = options.intervalMs ?? 150;
    const start = Date.now();
    let previous: Frame | undefined;
    let sameSince = start;
    let frames = 0;
    let state: string | undefined;
    for (;;) {
      let frame: Frame | undefined;
      try {
        frame = await this.frame(options.bundleId);
      } catch (error) {
        if (error instanceof RunnerRestartedError) throw error;
        this.#log(`frame failed: ${(error as Error).message}`);
      }
      if (!this.#hasFrame) return undefined;
      const now = Date.now();
      if (frame) {
        frames++;
        state = frame.state;
        const foreground = frame.state === undefined || frame.state === "foreground";
        if (!previous || !foreground || !sameFrame(previous, frame)) sameSince = now;
        previous = frame;
        const steady = now - sameSince;
        const blank = contentShare(frame) < 0.004;
        if (foreground && !blank && steady >= minStableMs) return { visible: true, blank: false, waitedMs: now - start, frames, ...(state ? { state } : {}) };
        if (foreground && blank && steady >= blankAcceptMs) return { visible: true, blank: true, waitedMs: now - start, frames, ...(state ? { state } : {}) };
      }
      if (now - start > timeoutMs) {
        this.#log(`the app's picture did not settle within ${timeoutMs} ms (state ${state ?? "?"}); asking for the layout anyway`);
        return { visible: false, blank: false, waitedMs: now - start, frames, ...(state ? { state } : {}) };
      }
      await sleep(intervalMs);
    }
  }

  /**
   * Polls `/source` until the layout is unchanged between two polls (and for `minStableMs`).
   * Returns the last snapshot with `stable: false` on timeout instead of throwing. An app that is
   * not running yet (right after a launch) is retried until the timeout.
   */
  async waitForStable(options: SettleOptions & { bundleId?: string } = {}): Promise<StableSnapshot> {
    const cached = this.#lastStable;
    if (cached && options.bundleId === undefined && Date.now() - cached.at < 1_000) return cached.snapshot;

    const intervalMs = options.intervalMs ?? this.#settle.intervalMs ?? 300;
    const timeoutMs = options.timeoutMs ?? this.#settle.timeoutMs ?? 10_000;
    const minStableMs = options.minStableMs ?? this.#settle.minStableMs ?? 0;
    const start = Date.now();
    let last: UISnapshot | undefined;
    let lastHash = "";
    let sameSince = 0;
    let lastError: unknown;
    let firstMs: number | undefined;
    for (;;) {
      try {
        const snapshot = await this.source(options.bundleId);
        const hash = layoutHash(snapshot.tree);
        const now = Date.now();
        firstMs ??= now - start;
        if (last && hash === lastHash) {
          if (now - sameSince >= minStableMs) {
            const result: StableSnapshot = { ...snapshot, stable: true, waitedMs: now - start, firstMs };
            this.#lastStable = { snapshot: result, at: now };
            return result;
          }
        } else {
          sameSince = now;
        }
        last = snapshot;
        lastHash = hash;
      } catch (error) {
        if (error instanceof RunnerRestartedError) throw error;
        // "<bundle> is not running" right after a launch: keep polling.
        lastError = error;
      }
      if (Date.now() - start > timeoutMs) {
        if (!last) throw lastError instanceof Error ? lastError : new RunnerError("/source", "no snapshot before timeout");
        this.#log(`layout did not settle within ${timeoutMs} ms; using the last snapshot`);
        return { ...last, stable: false, waitedMs: Date.now() - start, ...(firstMs !== undefined ? { firstMs } : {}) };
      }
      await sleep(intervalMs);
    }
  }

  // --- Internals ------------------------------------------------------------------

  async #afterAction(): Promise<void> {
    if (this.#settleAfterActions) await this.waitForStable();
  }

  async #area(within: ElementSelector | undefined): Promise<Rect> {
    const screen = this.#screen ?? (await this.screen());
    const full = { x: 0, y: 0, w: screen.width, h: screen.height };
    if (!within) return full;
    const snapshot = await this.source();
    return findFrame(snapshot.tree, within) ?? full;
  }

  async #request<T>(route: string, call: () => Promise<T>, idempotent: boolean): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const timedOut = error instanceof RunnerTimeoutError;
      const unreachable = timedOut || (error instanceof RunnerError && /request failed/.test(error.message));
      if (!unreachable) throw error;
      const health = await this.#answers();
      if (health) {
        // Alive. If it is still busy with this (or an earlier) request, wait for it instead of
        // restarting a runner that works: XCTest can hold a first snapshot for up to 60 s.
        const idle = await this.#untilIdle(route, health);
        if (idle) {
          if (idempotent) return call();
          // A timed-out action was received and has now finished: its effect happened.
          if (timedOut) return {} as T;
          throw error;
        }
        this.#log(`runner stayed busy for more than ${Math.round(this.timeouts.busy / 1000)} s after ${route}; treating it as hung`);
      }
      if (!this.#onHang) throw error;
      this.#log(`runner is not answering after ${route}; restarting it`);
      this.#restarting ??= this.#onHang().finally(() => {
        this.#restarting = undefined;
      });
      await this.#restarting;
      if (idempotent) return call();
      throw new RunnerRestartedError(route);
    }
  }

  /** `/health` within `hangCheck`, or undefined when the runner stays silent (hung or gone). */
  async #answers(): Promise<HealthResponse | undefined> {
    const deadline = Date.now() + this.timeouts.hangCheck;
    while (Date.now() < deadline) {
      try {
        return await this.health(Math.max(1_000, deadline - Date.now()));
      } catch {
        await sleep(500);
      }
    }
    return undefined;
  }

  /** Polls `/health` until the runner is no longer busy (true) or `timeouts.busy` has passed (false). */
  async #untilIdle(route: string, health: HealthResponse): Promise<boolean> {
    if (!health.busy) return true;
    const deadline = Date.now() + this.timeouts.busy;
    let noted = 0;
    let current: HealthResponse | undefined = health;
    while (current?.busy) {
      if (Date.now() - noted > 10_000) {
        this.#log(`runner busy with ${current.busy.route} for ${Math.round(current.busy.ms / 1000)} s (${current.busy.queued} queued) after ${route} timed out; waiting`);
        noted = Date.now();
      }
      if (Date.now() > deadline) return false;
      await sleep(500);
      current = await this.health().catch(() => undefined);
      if (!current) current = await this.#answers();
      if (!current) return false;
    }
    return true;
  }
}
