/**
 * RunnerDriver: DeviceDriver over ShotwrightRunner's HTTP API (ios/ShotwrightRunner/README.md).
 *
 * Readiness rules from docs/spikes/simulator.md:
 * - launch with `simctl launch` (fails fast) after pressing Home (no "◀ App" back-link), never the
 *   runner's `/launch` right after an install;
 * - after a launch or an action, poll `/source` until two consecutive snapshots have the same layout
 *   (at least 1.5 s of stability after a launch, so a splash screen is not taken as ready);
 * - every request has its own timeout; when one times out and `/health` stops answering too, the
 *   runner is restarted (`onHang`). Idempotent reads are retried once; actions throw
 *   RunnerRestartedError so the caller observes the screen again before acting.
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
import { layoutHash, type SettleOptions } from "./stable.ts";

/** ElementSelector plus the runner's optional disambiguators. */
export type RunnerSelector = ElementSelector & { readonly type?: string; readonly index?: number };

export interface RunnerTimeouts {
  readonly health: number;
  readonly source: number;
  readonly screenshot: number;
  readonly tap: number;
  readonly swipe: number;
  readonly type: number;
  readonly home: number;
  readonly launch: number;
  /** How long `/health` may stay silent after a timed-out request before the runner counts as hung. */
  readonly hangCheck: number;
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
  // The runner serves requests one at a time, so /health queues behind a slow call: give it time.
  hangCheck: 15_000,
};

export type StableSnapshot = UISnapshot & { readonly stable: boolean; readonly waitedMs: number };

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
  readonly log?: (message: string) => void;
}

interface HealthResponse {
  currentBundleId?: string;
  screen?: { w: number; h: number };
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

function selectorBody(selector: RunnerSelector | undefined): Record<string, unknown> {
  if (!selector) return {};
  const body: Record<string, unknown> = {};
  if (selector.id !== undefined) body.identifier = selector.id;
  if (selector.label !== undefined) body.label = selector.label;
  if (selector.type !== undefined) body.type = selector.type;
  if (selector.index !== undefined) body.index = selector.index;
  return body;
}

/** Frame of the `index`-th node matching the selector, depth-first. */
export function findFrame(tree: UINode, selector: RunnerSelector): Rect | undefined {
  let remaining = selector.index ?? 0;
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

  readonly #onHang: (() => Promise<void>) | undefined;
  readonly #settleAfterActions: boolean;
  readonly #settle: SettleOptions;
  readonly #log: (message: string) => void;
  #restarting: Promise<void> | undefined;
  #screen: ScreenInfo | undefined;
  #lastStable: { snapshot: StableSnapshot; at: number } | undefined;

  constructor(options: RunnerDriverOptions) {
    this.udid = options.udid;
    this.http = new RunnerHttp(options.port ?? 8615, options.host ?? "127.0.0.1");
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.#onHang = options.onHang;
    this.#settleAfterActions = options.settleAfterActions ?? true;
    this.#settle = options.settle ?? {};
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
    // Home first: launching while another app is in front adds a "◀ App" back-link to the status bar.
    await this.home().catch((error: unknown) => this.#log(`home before launch failed: ${String(error)}`));
    await launchApp(this.udid, options.bundleId, options.args ?? [], options.env ?? {});
    this.currentBundleId = options.bundleId;
    await this.waitForStable({ bundleId: options.bundleId, minStableMs: 1500, timeoutMs: 30_000 });
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
    for (;;) {
      try {
        const snapshot = await this.source(options.bundleId);
        const hash = layoutHash(snapshot.tree);
        const now = Date.now();
        if (last && hash === lastHash) {
          if (now - sameSince >= minStableMs) {
            const result: StableSnapshot = { ...snapshot, stable: true, waitedMs: now - start };
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
        return { ...last, stable: false, waitedMs: Date.now() - start };
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
      const unreachable = error instanceof RunnerTimeoutError || (error instanceof RunnerError && /request failed/.test(error.message));
      if (!unreachable || !this.#onHang) throw error;
      if (await this.#answers()) throw error; // slow, not hung
      this.#log(`runner is not answering after ${route}; restarting it`);
      this.#restarting ??= this.#onHang().finally(() => {
        this.#restarting = undefined;
      });
      await this.#restarting;
      if (idempotent) return call();
      throw new RunnerRestartedError(route);
    }
  }

  async #answers(): Promise<boolean> {
    const deadline = Date.now() + this.timeouts.hangCheck;
    while (Date.now() < deadline) {
      try {
        await this.health(Math.max(1_000, deadline - Date.now()));
        return true;
      } catch {
        await sleep(500);
      }
    }
    return false;
  }
}
