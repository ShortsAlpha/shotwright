/**
 * Explore, replay and compose jobs for one session. One job at a time; each is cancellable.
 *
 * Explore: app.build -> runner.ensure (boots the simulator) -> app.install -> live view and the
 * 9:41 status bar -> explore() (verifies its own flow at the end) -> screen judge.
 * Replay: runner.ensure -> replayFlow() once per locale, with the exploration's screen records so
 * every screenshot is checked.
 * Compose: captions for locales that have none (one Muse Spark Open call), the theme from the app
 * icon (agent `app.icon`, once), then every screenshot whose inputs changed (lib/compose). Needs no
 * simulator; a caption edit or a settings change restarts a running compose job.
 *
 * Progress goes to the session's browsers as JobEvents; files go to the run folder (artifacts.ts).
 */
import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { AgentMethod, AgentParams, AgentResult, ScreenInfo, SimDevice } from "@shotwright/core";
import {
  createProvider as createExplorerProvider,
  explore as runExplore,
  judgeScreens as runJudge,
  localeArgs,
  replayFlow as runReplay,
  type ExplorationResult,
  type ExplorerProvider,
  type JudgeResult,
  type ReplayResult,
} from "@shotwright/explorer";
import type { RemoteDriver } from "../realtime/remote-driver.ts";
import { CancellableDriver, JobCancelled, abortable, trackProvider } from "./abort.ts";
import { expandArgs, splitArgs } from "./args.ts";
import { buildManifest } from "./manifest.ts";
import { newRunId, runDir, sessionDir, writeJson, writeThumb } from "./artifacts.ts";
import { ScriptedProvider, stubJudge } from "./fake-models.ts";
import { fakeCaptionWriter, museCaptionWriter, type CaptionWriter } from "../compose/captions.ts";
import { composeRun, describeView, loadCompose, renderPreviews, setCaption, withComposeInfo } from "../compose/compose.ts";
import { getQuotas, QuotaError } from "../limits.ts";
import {
  EMPTY_JOBS,
  EXPLORER_MODELS,
  LOCALES,
  MAX_TURNS,
  applyJobEvent,
  isActive,
  localeName,
  modelLabel,
  type CaptionParams,
  type ComposeParams,
  type ExploreParams,
  type ExplorerModel,
  type JobEvent,
  type JobKind,
  type JobPhase,
  type JobView,
  type JobsSnapshot,
  type JudgeView,
  type LocaleRun,
  type PreviewParams,
  type ReplayParams,
  type RunView,
  type ShotView,
} from "./state.ts";

/** What a job needs from its session (kept narrow so this module does not import Session). */
export interface JobHost {
  readonly sessionId: string;
  readonly agentConnected: boolean;
  call<M extends AgentMethod>(method: M, params: AgentParams<M>): Promise<AgentResult<M>>;
  driver(): RemoteDriver;
  device(udid: string): SimDevice | undefined;
  startLiveView(): Promise<void>;
  log(level: "info" | "warn" | "error", message: string): void;
  emit(event: JobEvent): void;
  /** A quota was used (the page shows what is left). */
  quotaChanged?(): void;
}

/** The explorer's API, injectable for tests. */
export interface JobDeps {
  readonly explore: typeof runExplore;
  readonly replayFlow: typeof runReplay;
  readonly judgeScreens: typeof runJudge;
  readonly createProvider: (model: ExplorerModel) => ExplorerProvider;
  /** True, or why there is no judge (the explorer's ranking is used then). */
  readonly judgeAvailable: () => string | true;
  /** Writes captions for compose, or says why it can't (the English captions are used then). */
  readonly captionWriter: () => CaptionWriter | string;
}

const fakeModels = process.env.SHOTWRIGHT_FAKE_MODELS === "1";

export const DEFAULT_DEPS: JobDeps = fakeModels
  ? {
      explore: runExplore,
      replayFlow: runReplay,
      judgeScreens: stubJudge,
      createProvider: () => new ScriptedProvider(),
      judgeAvailable: () => true,
      captionWriter: () => fakeCaptionWriter,
    }
  : {
      explore: runExplore,
      replayFlow: runReplay,
      judgeScreens: runJudge,
      createProvider: (model) => createExplorerProvider(model, model === "open" ? {} : { reasoningEffort: "low" }),
      judgeAvailable: () => (process.env.BASETEN_API_KEY ? true : "BASETEN_API_KEY is not set on the server, so the explorer's ranking is used."),
      captionWriter: () =>
        process.env.BASETEN_API_KEY ? museCaptionWriter({ reasoningEffort: "low" }) : "BASETEN_API_KEY is not set on the server, so the English captions are used.",
    };

/** Per-run spending limit for the explorer, USD. */
const MAX_COST_USD = Number(process.env.SHOTWRIGHT_MAX_EXPLORE_USD ?? 1);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const firstLine = (text: string) => text.split("\n")[0]!.slice(0, 400);

/** What a finished exploration leaves for replays. */
interface Exploration {
  readonly runId: string;
  readonly dir: string;
  readonly params: ExploreParams;
  readonly bundleId: string;
  readonly appName: string;
  readonly screen: ScreenInfo;
  readonly result: ExplorationResult;
  judge?: JudgeResult;
  /** Locale -> replay summary, merged across replay jobs. */
  readonly replays: Map<string, { ok: boolean; totalMs: number; launchArgs: readonly string[]; steps: ReplayResult["steps"]; screenshots: Array<{ name: string; verified: boolean; checks: unknown; file: string }> }>;
}

function parseExplore(input: unknown): ExploreParams {
  const p = (input ?? {}) as Record<string, unknown>;
  const str = (key: string, max = 2000) => {
    const v = p[key];
    if (typeof v !== "string") throw new Error(`"${key}" must be a string`);
    if (v.length > max) throw new Error(`"${key}" is too long`);
    return v.trim();
  };
  const projectPath = str("projectPath");
  const scheme = str("scheme", 200);
  const udid = str("udid", 64);
  if (!projectPath || !scheme) throw new Error("Pick a project and a scheme first.");
  if (!udid) throw new Error("Pick a simulator first.");
  const locales = parseLocales(p.locales);
  const model = typeof p.model === "string" && EXPLORER_MODELS.some((m) => m.id === p.model) ? (p.model as ExplorerModel) : "spark";
  return { projectPath, scheme, udid, launchArgs: str("launchArgs"), hint: str("hint", 300), locales, model };
}

function parseLocales(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("Pick at least one language.");
  const known = new Set<string>(LOCALES.map((l) => l.code));
  const locales = [...new Set(input.filter((l): l is string => typeof l === "string" && known.has(l)))];
  if (locales.length === 0) throw new Error("Pick at least one language.");
  return locales;
}

/** "Renew.xcodeproj" -> "Renew"; the scheme usually names the app better. */
const appNameOf = (params: ExploreParams) => params.scheme || basename(params.projectPath, extname(params.projectPath));

const JOB_NAMES: Record<JobKind, string> = { explore: "Exploration", replay: "Replay", compose: "Compose" };

export class SessionJobs {
  private state: JobsSnapshot = EMPTY_JOBS;
  private controller: AbortController | null = null;
  /** Settles when the running job has finished (after its `ended` event). */
  private running: Promise<void> | null = null;
  private exploration: Exploration | null = null;
  private readonly host: JobHost;
  private readonly deps: JobDeps;
  private nextJob = 1;

  constructor(host: JobHost, deps: JobDeps = DEFAULT_DEPS) {
    this.host = host;
    this.deps = deps;
  }

  get snapshot(): JobsSnapshot {
    return this.state;
  }

  /** True while a job runs or is still unwinding after a cancel. */
  get active(): boolean {
    return isActive(this.state.job);
  }

  /** A job is using the simulator (compose jobs don't), so the browser must not drive it. */
  get driving(): boolean {
    return this.active && this.state.job?.kind !== "compose";
  }

  private emit(event: JobEvent): void {
    this.state = applyJobEvent(this.state, event);
    this.host.emit(event);
  }

  private readonly touched = (point: { x: number; y: number }) => this.emit({ type: "touch", x: point.x, y: point.y, at: Date.now() });

  private phase(phase: JobPhase, label: string): void {
    this.emit({ type: "phase", phase, label, at: Date.now() });
  }

  private begin(kind: JobKind, runId: string): { job: JobView; signal: AbortSignal } {
    if (this.active) throw new Error("A job is already running. Stop it first.");
    if (kind !== "compose" && !this.host.agentConnected) throw new Error("The Mac agent is not connected.");
    this.controller = new AbortController();
    const job: JobView = { id: `j${this.nextJob++}`, kind, status: "running", startedAt: Date.now(), runId };
    return { job, signal: this.controller.signal };
  }

  private finish(signal: AbortSignal, error: unknown): void {
    if (error === undefined) {
      this.emit({ type: "ended", status: "done", at: Date.now() });
    } else if (signal.aborted || error instanceof JobCancelled) {
      this.host.log("warn", "Stopped.");
      this.emit({ type: "ended", status: "cancelled", at: Date.now() });
    } else {
      const text = firstLine(message(error));
      this.host.log("error", `${JOB_NAMES[this.state.job?.kind ?? "explore"]} failed: ${text}`);
      this.emit({ type: "ended", status: "failed", error: text, at: Date.now() });
    }
    this.controller = null;
  }

  cancel(): boolean {
    if (!this.controller || this.state.job?.status !== "running") return false;
    this.emit({ type: "cancelling" });
    this.controller.abort();
    return true;
  }

  /** Session ended: stop whatever runs. */
  close(): void {
    this.controller?.abort();
  }

  // --- Explore ----------------------------------------------------------------------

  /** Runs a started job and records its promise (a compose restart waits for it). */
  private track(signal: AbortSignal, work: Promise<void>, onError?: (error: unknown) => void): void {
    this.running = work.then(
      () => this.finish(signal, undefined),
      (error: unknown) => {
        onError?.(error);
        this.finish(signal, error);
      },
    );
  }

  startExplore(input: unknown): JobView {
    const params = parseExplore(input);
    if (this.active) throw new Error("A job is already running. Stop it first.");
    const quotas = getQuotas();
    quotas.check("explore", this.host.sessionId);
    const runId = newRunId();
    const { job, signal } = this.begin("explore", runId);
    quotas.consume("explore", this.host.sessionId);
    this.host.quotaChanged?.();
    const device = this.host.device(params.udid);
    const run: RunView = {
      runId,
      createdAt: Date.now(),
      project: { path: params.projectPath, scheme: params.scheme, appName: appNameOf(params) },
      device: { udid: params.udid, ...(device && { name: device.name }) },
      model: params.model,
      launchArgs: params.launchArgs,
      hint: params.hint,
      locales: params.locales,
      explorationLocale: params.locales[0]!,
      maxTurns: MAX_TURNS,
      steps: [],
      marks: [],
      usage: { input: 0, cachedInput: 0, output: 0, reasoning: 0 },
      costUsd: 0,
      replays: [],
    };
    this.exploration = null;
    this.emit({ type: "started", job, run });
    this.track(signal, this.explore(params, run, signal));
    return this.state.job!;
  }

  private async explore(params: ExploreParams, run: RunView, signal: AbortSignal): Promise<void> {
    const { host, deps } = this;
    const dir = runDir(host.sessionId, run.runId);
    const appName = run.project.appName;
    const locale = run.explorationLocale;
    const call = <M extends AgentMethod>(method: M, p: AgentParams<M>) => abortable(signal, host.call(method, p));
    const jobFile = join(dir, "job.json");
    const jobRecord = (extra: Record<string, unknown>) =>
      writeJson(jobFile, { kind: "explore", runId: run.runId, sessionId: host.sessionId, params, device: run.device, startedAt: new Date(run.createdAt).toISOString(), ...extra });
    await jobRecord({ status: "running" });
    await writeJson(join(sessionDir(host.sessionId), "latest.json"), { runId: run.runId, dir });

    // Fail early on a missing key rather than after a two-minute build.
    const provider = deps.createProvider(params.model);

    host.log("info", `Exploring ${appName} with ${modelLabel(params.model)} on ${run.device.name ?? params.udid}`);
    this.phase("build", `Building ${params.scheme}`);
    const built = await call("app.build", { projectPath: params.projectPath, scheme: params.scheme, udid: params.udid, configuration: "Debug" });
    this.emit({ type: "project", project: { ...run.project, bundleId: built.bundleId } });

    this.phase("runner", "Starting the simulator");
    const screen = await call("runner.ensure", { udid: params.udid });
    this.phase("install", `Installing ${appName}`);
    await call("app.install", { udid: params.udid, appPath: built.appPath });

    const remote = host.driver();
    const driver = new CancellableDriver(remote, signal, this.touched);
    await host.startLiveView().catch((error: unknown) => host.log("warn", `Live view: ${message(error)}`));
    await driver.statusBar(true).catch((error: unknown) => {
      if (error instanceof JobCancelled) throw error;
      host.log("warn", `Could not set the 9:41 status bar: ${message(error)}`);
    });

    // Exploration locale: the user's arguments with {language}/{region} filled in, then the
    // locale itself (without -AppleLocale the simulator may format "$51,63").
    const userArgs = splitArgs(params.launchArgs);
    const launchArgs = [...expandArgs(userArgs, locale), ...localeLaunchArgs(locale)];

    let turn = 0;
    let lastReply: { reasoning?: string; text: string; ms: number } | undefined;
    let total = { usage: run.usage, costUsd: 0 };
    const tracked = trackProvider(provider, signal, (reply, usage, costUsd) => {
      lastReply = { text: reply.text, ms: reply.ms, ...(reply.reasoning && { reasoning: reply.reasoning }) };
      total = { usage, costUsd };
    });
    const thumbs: Promise<void>[] = [];

    this.phase("explore", `Exploring with ${modelLabel(params.model)}`);
    const result = await deps.explore({
      driver,
      provider: tracked,
      bundleId: built.bundleId,
      launchArgs,
      appName,
      ...(params.hint && { hint: params.hint }),
      maxSteps: MAX_TURNS,
      maxCostUsd: MAX_COST_USD,
      outDir: dir,
      log: (line) => {
        if (line.startsWith("verifying the flow")) this.phase("verify", "Replaying the flow to verify it");
        // The step feed shows turns and marks; passing verification steps are noise in the log.
        if (/^(turn \d+:|\s+marked |\s+verify\s+\d+\s+\w+\s+(ok|miss)\b)/.test(line) || signal.aborted) return;
        host.log(line.startsWith("exploration error") ? "error" : "info", `explore: ${firstLine(line.trim())}`);
      },
      onEvent: (event) => {
        switch (event.kind) {
          case "turn": {
            turn = event.turn;
            const reply = lastReply;
            lastReply = undefined;
            const text = event.text.trim();
            this.emit({
              type: "step",
              step: {
                turn: event.turn,
                calls: event.calls.map((c) => ({ name: c.name, args: clipArgs(c.args) })),
                costUsd: total.costUsd,
                ...(text && { text: text.slice(0, 1000) }),
                ...(reply?.reasoning && { reasoning: reply.reasoning.slice(0, 2000) }),
                ...(reply && { modelMs: reply.ms }),
              },
              usage: total.usage,
              costUsd: total.costUsd,
            });
            break;
          }
          case "action":
            this.emit({ type: "action", turn: event.turn, name: event.name, output: event.output.slice(0, 600) });
            break;
          case "mark": {
            const markTurn = turn;
            const thumb = `thumbs/${event.name}.jpg`;
            thumbs.push(
              writeThumb(event.png, join(dir, thumb))
                .catch((error: unknown) => host.log("warn", `Thumbnail for ${event.name}: ${message(error)}`))
                .then(() => {
                  this.emit({
                    type: "mark",
                    mark: { name: event.name, score: event.score, why: event.why, image: `screens/${event.name}.png`, thumb, turn: markTurn },
                  });
                }),
            );
            break;
          }
          case "observation":
            break;
        }
      },
    });
    await Promise.all(thumbs);

    const verified = result.verification?.screenshots.filter((s) => s.verified).map((s) => s.name) ?? [];
    this.emit({
      type: "explored",
      summary: {
        stoppedBecause: result.stoppedBecause,
        turns: result.turns,
        actions: result.actions,
        ranked: result.ranked,
        notes: result.notes,
        costUsd: result.costUsd,
        flowSteps: result.flow.steps.length,
        verified,
        failed: result.verification?.failed ?? [],
        warnings: result.warnings.slice(0, 20),
        totalMs: result.timing.totalMs,
        ...(result.error && { error: firstLine(result.error) }),
      },
    });
    const exploration: Exploration = {
      runId: run.runId,
      dir,
      params,
      bundleId: built.bundleId,
      appName,
      screen,
      result,
      replays: new Map(),
    };
    // Whatever was marked can be replayed, even when the run was stopped early.
    if (result.screens.length > 0) {
      this.exploration = exploration;
      await this.writeManifest(exploration);
    }
    if (signal.aborted) throw new JobCancelled();
    host.log(
      "info",
      `Explored ${appName}: ${result.screens.length} screens in ${result.turns} turns, $${result.costUsd.toFixed(3)} (${result.stoppedBecause})`,
    );
    if (result.screens.length === 0) {
      throw new Error(result.error ? `The explorer stopped: ${firstLine(result.error)}` : `No screens were marked (${result.stoppedBecause}).`);
    }

    // Screen judge: ranks the marked screens and writes a caption for each.
    this.phase("judge", "Ranking screens and writing captions");
    const available = deps.judgeAvailable();
    let judge: JudgeView;
    if (available !== true) {
      judge = { skipped: available };
    } else {
      const screens = await Promise.all(
        result.ranked
          .map((name) => result.screens.find((s) => s.name === name))
          .filter((s) => s !== undefined)
          .map(async (s) => ({ name: s.name, why: s.why, png: new Uint8Array(await readFile(join(dir, "screens", `${s.name}.png`))) })),
      );
      try {
        const judged = await abortable(signal, deps.judgeScreens({ screens, appName, ...(params.hint && { appDescription: params.hint }) }));
        exploration.judge = judged;
        await writeJson(join(dir, "judge.json"), judged);
        judge = { model: judged.model, ms: judged.ms, notes: judged.notes, ranking: judged.ranking };
        host.log("info", `Judge (${judged.model}): ${judged.ranking.map((r) => r.name).join(", ")} in ${(judged.ms / 1000).toFixed(1)} s`);
      } catch (error) {
        if (error instanceof JobCancelled || signal.aborted) throw error;
        host.log("warn", `The screen judge failed (${firstLine(message(error))}); using the explorer's ranking.`);
        judge = { skipped: `The screen judge failed: ${firstLine(message(error))}` };
      }
    }
    this.emit({ type: "judge", judge });
    await this.writeManifest(exploration);
    await jobRecord({ status: "done", bundleId: built.bundleId, endedAt: new Date().toISOString(), costUsd: result.costUsd });
    await this.refreshCompose();
  }

  // --- Replay -----------------------------------------------------------------------

  startReplay(input: unknown): JobView {
    const params = (input ?? {}) as Partial<ReplayParams>;
    const locales = parseLocales(params.locales);
    const exploration = this.exploration;
    if (!exploration || this.state.run?.runId !== exploration.runId) throw new Error("Explore the app first.");
    const begun = this.begin("replay", exploration.runId);
    const signal = begun.signal;
    const job: JobView = { ...begun.job, locales };
    const total = exploration.result.flow.steps.length;
    let run = this.state.run!;
    for (const locale of locales) {
      const previous = run.replays.find((r) => r.locale === locale);
      const fresh: LocaleRun = { locale, status: "pending", step: 0, total, shots: [], version: (previous?.version ?? 0) + 1 };
      run = { ...run, replays: previous ? run.replays.map((r) => (r.locale === locale ? fresh : r)) : [...run.replays, fresh] };
    }
    this.emit({ type: "started", job, run });
    this.track(
      signal,
      this.replay(exploration, locales, signal).finally(() => this.refreshCompose()),
      (error) => {
        for (const r of this.state.run?.replays ?? []) {
          if (r.status === "pending" || r.status === "running") {
            this.emit({ type: "locale", run: { ...r, status: signal.aborted ? "cancelled" : "failed", ...(signal.aborted ? {} : { error: firstLine(message(error)) }) } });
          }
        }
      },
    );
    return this.state.job!;
  }

  private async replay(exploration: Exploration, locales: readonly string[], signal: AbortSignal): Promise<void> {
    const { host, deps } = this;
    const { params, dir, result } = exploration;
    const flow = result.flow;
    this.phase("runner", "Starting the simulator");
    await abortable(signal, host.call("runner.ensure", { udid: params.udid }));
    const driver = new CancellableDriver(host.driver(), signal, this.touched);
    await host.startLiveView().catch((error: unknown) => host.log("warn", `Live view: ${message(error)}`));
    await driver.statusBar(true).catch((error: unknown) => {
      if (error instanceof JobCancelled) throw error;
      host.log("warn", `Could not set the 9:41 status bar: ${message(error)}`);
    });
    const userArgs = splitArgs(params.launchArgs);
    const current = (locale: string) => this.state.run!.replays.find((r) => r.locale === locale)!;

    for (const locale of locales) {
      if (signal.aborted) throw new JobCancelled();
      this.phase("replay", `Replaying in ${localeName(locale)}`);
      const outDir = join(dir, "replay", locale);
      const shots: ShotView[] = [];
      const update = (patch: Partial<LocaleRun>) => this.emit({ type: "locale", run: { ...current(locale), ...patch } });
      update({ status: "running" });
      let chain = Promise.resolve();
      /** Thumbnail as soon as a screenshot is on disk (from the log), or from the result's PNG. */
      const addShot = (name: string, verified: boolean, png?: Uint8Array) => {
        chain = chain.then(async () => {
          const index = shots.findIndex((s) => s.name === name);
          if (index >= 0 && shots[index]!.thumb) return;
          const thumb = `replay/${locale}/thumbs/${name}.jpg`;
          let made = true;
          try {
            await writeThumb(png ?? new Uint8Array(await readFile(join(outDir, `${name}.png`))), join(dir, thumb));
          } catch (error) {
            made = false;
            if (png) host.log("warn", `Thumbnail for ${locale}/${name}: ${message(error)}`);
          }
          const view: ShotView = { name, verified, image: `replay/${locale}/${name}.png`, thumb: made ? thumb : "" };
          if (index >= 0) shots[index] = view;
          else shots.push(view);
          update({ shots: [...shots] });
        });
      };
      const launchArgs = expandArgs(userArgs, locale);
      host.log("info", `Replay ${locale}: ${[...launchArgs, ...localeLaunchArgs(locale)].join(" ") || "(no launch arguments)"}`);
      const replayed = await deps.replayFlow(driver, flow, {
        locale: { language: locale },
        launchArgs,
        screens: result.screens,
        outDir,
        log: (line) => {
          // "   3 tap        ok   812 ms  detail": progress, and a thumbnail as soon as a screenshot lands.
          const match = /^\s*(\d+)\s+(\w+)\s+(ok|miss|FAIL)\b/.exec(line);
          if (!match || signal.aborted) return;
          const index = Number(match[1]);
          const ok = match[3] !== "FAIL";
          if (!ok) host.log("warn", `replay ${locale}: ${firstLine(line.trim())}`);
          update({ step: Math.min(index + 1, flow.steps.length) });
          const step = flow.steps[index];
          if (step?.action === "screenshot") addShot(step.name, ok);
        },
      });
      if (signal.aborted) throw new JobCancelled();
      for (const shot of replayed.screenshots) addShot(shot.name, shot.verified, shot.png);
      await chain;
      // The result is the truth for verification; the log only gave progress.
      const finalShots: ShotView[] = replayed.screenshots.map((r) => ({
        name: r.name,
        verified: r.verified,
        image: `replay/${locale}/${r.name}.png`,
        thumb: shots.find((x) => x.name === r.name)?.thumb ?? "",
      }));
      const verifiedCount = finalShots.filter((s) => s.verified).length;
      update({ status: "done", step: flow.steps.length, shots: finalShots, ms: replayed.totalMs });
      host.log(
        verifiedCount === finalShots.length ? "info" : "warn",
        `Replay ${locale}: ${verifiedCount}/${finalShots.length} screens verified in ${(replayed.totalMs / 1000).toFixed(0)} s`,
      );
      exploration.replays.set(locale, {
        ok: replayed.ok,
        totalMs: replayed.totalMs,
        launchArgs: replayed.launchArgs,
        steps: replayed.steps,
        screenshots: replayed.screenshots.map((s) => ({ name: s.name, verified: s.verified, checks: s.checks, file: `replay/${locale}/${s.name}.png` })),
      });
      await writeJson(join(dir, "replay", "replay.json"), Object.fromEntries(exploration.replays));
      await this.writeManifest(exploration);
    }
  }

  // --- Compose ----------------------------------------------------------------------

  /** The run folder of the session's current exploration, or why there is nothing to compose. */
  private composeDir(): string {
    const exploration = this.exploration;
    if (!exploration || this.state.run?.runId !== exploration.runId) throw new Error("Explore the app first.");
    return exploration.dir;
  }

  /** Reloads the compose view from the run folder (after replays, a caption edit, a download…). */
  async refreshCompose(): Promise<void> {
    const exploration = this.exploration;
    if (!exploration || this.state.run?.runId !== exploration.runId) return;
    try {
      const compose = await loadCompose(exploration.dir);
      if (compose && this.state.run?.runId === exploration.runId) this.emit({ type: "compose", compose });
    } catch (error) {
      this.host.log("warn", `Compose: ${firstLine(message(error))}`);
    }
  }

  /** Stops a running compose job and waits until it has unwound (other jobs: an error). */
  private async stopCompose(): Promise<void> {
    if (!this.active) return;
    if (this.state.job?.kind !== "compose") throw new Error(`${JOB_NAMES[this.state.job!.kind]} is running; compose when it has finished.`);
    this.cancel();
    await this.running;
  }

  /**
   * Starts a compose job, restarting one that runs (renders that finished are kept). Captions are
   * written only for locales without them, so a normal compose makes at most one model call.
   */
  async startCompose(input: unknown): Promise<JobView> {
    const params = (input ?? {}) as ComposeParams;
    const dir = this.composeDir();
    await this.stopCompose();
    const host = this.host;
    const quotas = getQuotas();
    if (params.regenerateCaptions) quotas.check("captions", host.sessionId);

    const { job, signal } = this.begin("compose", this.state.run!.runId);
    const compose = await loadCompose(dir).catch(() => undefined);
    const run: RunView = { ...this.state.run!, ...(compose && { compose }) };
    this.emit({ type: "started", job, run });

    const work = async () => {
      // Captions: the writer counts against the caption quota; when that is used up, English is used.
      const available = this.deps.captionWriter();
      let captionWriter: CaptionWriter | undefined;
      if (typeof available === "string") host.log("warn", available);
      else {
        captionWriter = async (request, s) => {
          quotas.check("captions", host.sessionId);
          quotas.consume("captions", host.sessionId);
          host.quotaChanged?.();
          host.log("info", `Writing captions in ${request.locales.map(localeName).join(", ")} with Muse Spark Open`);
          const result = await available(request, s);
          host.log("info", `Captions: ${request.screens.length} screens × ${request.locales.length} languages in ${(result.ms / 1000).toFixed(1)} s (${result.calls} call${result.calls === 1 ? "" : "s"})`);
          return result;
        };
      }
      const projectPath = this.exploration?.params.projectPath;
      const started = Date.now();
      const runCompose = (writer: CaptionWriter | undefined) =>
        composeRun(dir, {
          ...(params.settings && { settings: params.settings }),
          ...(writer && { captionWriter: writer }),
          ...(params.regenerateCaptions && { regenerateCaptions: true }),
          // Without the agent the default theme is used for now, and the icon is read next time.
          ...(host.agentConnected &&
            projectPath && {
              icon: async () => {
                const icon = await abortable(signal, host.call("app.icon", { projectPath }));
                if (!icon) host.log("info", "No app icon found in the project; using the default theme.");
                else host.log("info", `Theme from the app icon (${icon.file}, ${icon.width}×${icon.height})`);
                return icon ? new Uint8Array(Buffer.from(icon.png, "base64")) : null;
              },
            }),
          signal,
          onEvent: (event) => {
            switch (event.type) {
              case "phase":
                this.phase(event.phase, event.label);
                break;
              case "view":
                this.emit({ type: "compose", compose: event.view });
                break;
              case "render":
                this.emit({ type: "render", set: event.set, locale: event.locale, render: event.render });
                break;
              case "progress":
                this.emit({ type: "progress", done: event.done, total: event.total });
                break;
            }
          },
        });
      let summary;
      try {
        summary = await runCompose(captionWriter);
      } catch (error) {
        // Out of caption quota (or the model failed): compose with the captions there are.
        if (signal.aborted || error instanceof JobCancelled || !captionWriter || params.regenerateCaptions) throw error;
        host.log("warn", `${error instanceof QuotaError ? "" : "Captions failed: "}${firstLine(message(error))} Using the English captions for now.`);
        summary = await runCompose(undefined);
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      host.log(
        summary.failed ? "warn" : "info",
        `Composed ${describeView(summary.view)}: ${summary.rendered} rendered, ${summary.upToDate} up to date${summary.failed ? `, ${summary.failed} failed` : ""} in ${seconds} s`,
      );
      if (summary.failed) throw new Error(`${summary.failed} screenshot${summary.failed === 1 ? "" : "s"} failed to render`);
    };
    this.track(signal, work());
    return this.state.job!;
  }

  /** Saves a caption from the gallery and re-renders its image (now, or after the running job). */
  async editCaption(input: unknown): Promise<unknown> {
    const p = (input ?? {}) as Partial<CaptionParams>;
    if (typeof p.locale !== "string" || typeof p.screen !== "string" || typeof p.text !== "string" || p.text.length > 200) {
      throw new Error("Expected { locale, screen, text }");
    }
    const dir = this.composeDir();
    const restart = this.active && this.state.job?.kind === "compose";
    if (restart) await this.stopCompose();
    const caption = await setCaption(dir, p.locale, p.screen, p.text);
    this.emit({ type: "caption", locale: p.locale, screen: p.screen, caption });
    await this.refreshCompose();
    // A replay may be driving the simulator: the image shows as stale until the next compose.
    if (!this.active) await this.startCompose({});
    return caption;
  }

  /** Template picker thumbnails for these settings. */
  async preview(input: unknown): Promise<Record<string, string>> {
    const p = (input ?? {}) as PreviewParams;
    return renderPreviews(this.composeDir(), p.settings ?? {}, typeof p.locale === "string" ? p.locale : undefined);
  }

  private async writeManifest(exploration: Exploration): Promise<void> {
    const device = this.host.device(exploration.params.udid);
    const manifest = buildManifest({
      runId: exploration.runId,
      createdAt: this.state.run?.createdAt ?? Date.now(),
      params: exploration.params,
      appName: exploration.appName,
      bundleId: exploration.bundleId,
      device,
      screen: exploration.screen,
      result: exploration.result,
      ...(exploration.judge && { judge: exploration.judge }),
      replays: exploration.replays,
    });
    await writeJson(join(exploration.dir, "manifest.json"), await withComposeInfo(manifest, exploration.dir));
  }
}

/** `-AppleLanguages (de) -AppleLocale de_DE`, as replayFlow adds them. */
const localeLaunchArgs = (locale: string): string[] => localeArgs({ language: locale });

/** Long strings in tool arguments (typed text, notes) are clipped for the page. */
function clipArgs(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "string" && v.length > 300 ? `${v.slice(0, 299)}…` : v]));
}
