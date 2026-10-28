import type { CaptionView, ComposeSettings, ComposeView, RenderView } from "../compose/state.ts";

/**
 * Explore, replay and compose jobs as the browser sees them. The server keeps a `JobsSnapshot` per session,
 * sends it whole when a browser connects (`jobs`) and then sends each change as a `JobEvent`
 * (`job.event`). Both ends apply events with `applyJobEvent`, so they never drift apart.
 *
 * No Node imports here: the session page imports this file.
 */

/** Model turns per exploration. */
export const MAX_TURNS = 40;

export const LOCALES = [
  { code: "en", name: "English" },
  { code: "de", name: "Deutsch" },
  { code: "ja", name: "日本語" },
  { code: "fr", name: "Français" },
  { code: "es", name: "Español" },
  { code: "it", name: "Italiano" },
  { code: "pt", name: "Português" },
  { code: "ko", name: "한국어" },
  { code: "zh-Hans", name: "简体中文" },
  { code: "tr", name: "Türkçe" },
  { code: "nl", name: "Nederlands" },
  { code: "ar", name: "العربية" },
] as const;

export type LocaleCode = (typeof LOCALES)[number]["code"];

export const DEFAULT_LOCALES: readonly LocaleCode[] = ["en", "de", "ja"];

export const localeName = (code: string): string => LOCALES.find((l) => l.code === code)?.name ?? code;

export const EXPLORER_MODELS = [
  { id: "spark", label: "Muse Spark 1.3" },
  { id: "wonder", label: "Muse Wonder" },
  { id: "open", label: "Muse Spark Open" },
] as const;

export type ExplorerModel = (typeof EXPLORER_MODELS)[number]["id"];

export const modelLabel = (id: string): string => EXPLORER_MODELS.find((m) => m.id === id)?.label ?? id;

// --- Requests ------------------------------------------------------------------

export interface ExploreParams {
  readonly projectPath: string;
  readonly scheme: string;
  /** The simulator to build for and explore on. */
  readonly udid: string;
  /** As typed: split like a shell line; `{language}` and `{region}` are replaced per locale. */
  readonly launchArgs: string;
  /** What the app does, in a few words (helps the explorer and the judge). */
  readonly hint: string;
  /** Replay locales; the first one is also the exploration's locale. */
  readonly locales: readonly string[];
  readonly model: ExplorerModel;
}

export interface ReplayParams {
  readonly locales: readonly string[];
}

/** Start (or restart) a compose job: captions for missing locales, theme, then every changed image. */
export interface ComposeParams {
  readonly settings?: Partial<ComposeSettings>;
  /** Rewrite every caption that was not edited by hand (one Muse call). */
  readonly regenerateCaptions?: boolean;
}

/** Save a caption typed in the gallery (empty text resets it), then re-render that image. */
export interface CaptionParams {
  readonly locale: string;
  readonly screen: string;
  readonly text: string;
}

/** Small renders of the first screen in every template (answered with { template: dataUrl }). */
export interface PreviewParams {
  readonly settings?: Partial<ComposeSettings>;
  readonly locale?: string;
}

/** "preview" and "caption" answer right away; the others start or stop a job. */
export type JobAction = "explore" | "replay" | "compose" | "caption" | "preview" | "cancel";

// --- State ----------------------------------------------------------------------

export type JobKind = "explore" | "replay" | "compose";
export type JobStatus = "running" | "cancelling" | "done" | "failed" | "cancelled";
export type JobPhase = "build" | "runner" | "install" | "explore" | "verify" | "judge" | "replay" | "captions" | "theme" | "render";

export interface Usage {
  readonly input: number;
  readonly cachedInput: number;
  readonly output: number;
  readonly reasoning: number;
}

export interface CallView {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** What the explorer told the model after running the call. */
  readonly output?: string;
}

/** One model turn: the tool calls it made, and its reasoning when the provider returns it. */
export interface StepView {
  readonly turn: number;
  readonly calls: readonly CallView[];
  readonly text?: string;
  readonly reasoning?: string;
  readonly modelMs?: number;
  /** Total cost of the run after this turn, USD. */
  readonly costUsd: number;
}

/** Paths are relative to the run folder; see `artifactUrl`. */
export interface MarkView {
  readonly name: string;
  readonly score: number;
  readonly why: string;
  readonly image: string;
  readonly thumb: string;
  readonly turn: number;
}

export interface JudgedView {
  readonly name: string;
  readonly rank: number;
  readonly score: number;
  readonly caption: string;
  readonly reason: string;
}

export type JudgeView =
  | { readonly model: string; readonly ms: number; readonly notes: string; readonly ranking: readonly JudgedView[]; readonly skipped?: undefined }
  | { readonly skipped: string };

export interface ExploreSummary {
  readonly stoppedBecause: string;
  readonly turns: number;
  readonly actions: number;
  /** Marked screen names, explorer's ranking. */
  readonly ranked: readonly string[];
  readonly notes: string;
  readonly costUsd: number;
  readonly flowSteps: number;
  /** Screens the verification replay reached again; `failed` did not. */
  readonly verified: readonly string[];
  readonly failed: readonly string[];
  readonly warnings: readonly string[];
  readonly totalMs: number;
  readonly error?: string;
}

export interface ShotView {
  readonly name: string;
  readonly verified: boolean;
  readonly image: string;
  readonly thumb: string;
}

export interface LocaleRun {
  readonly locale: string;
  readonly status: "pending" | "running" | "done" | "failed" | "cancelled";
  /** Flow steps finished, of `total`. */
  readonly step: number;
  readonly total: number;
  readonly shots: readonly ShotView[];
  readonly ms?: number;
  readonly error?: string;
  /** Bumped on every replay of this locale, to bust cached thumbnails. */
  readonly version: number;
}

/** One exploration and the replays made from it. */
export interface RunView {
  readonly runId: string;
  readonly createdAt: number;
  readonly project: { readonly path: string; readonly scheme: string; readonly appName: string; readonly bundleId?: string };
  readonly device: { readonly udid: string; readonly name?: string };
  readonly model: ExplorerModel;
  readonly launchArgs: string;
  readonly hint: string;
  readonly locales: readonly string[];
  readonly explorationLocale: string;
  readonly maxTurns: number;
  readonly steps: readonly StepView[];
  readonly marks: readonly MarkView[];
  readonly usage: Usage;
  readonly costUsd: number;
  readonly summary?: ExploreSummary;
  readonly judge?: JudgeView;
  readonly replays: readonly LocaleRun[];
  /** Captions, theme and rendered screenshots, once the run has captures to compose. */
  readonly compose?: ComposeView;
}

export interface JobView {
  readonly id: string;
  readonly kind: JobKind;
  readonly status: JobStatus;
  readonly phase?: JobPhase;
  readonly phaseLabel?: string;
  readonly phaseAt?: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly error?: string;
  readonly runId: string;
  /** Replay jobs: the locales, in order. */
  readonly locales?: readonly string[];
  /** The agent's latest tap, in points, for a ripple in the live view. */
  readonly touch?: { readonly x: number; readonly y: number; readonly at: number };
  /** Compose jobs: screenshots rendered (or already up to date) of the total. */
  readonly progress?: { readonly done: number; readonly total: number };
}

export interface JobsSnapshot {
  readonly job: JobView | null;
  readonly run: RunView | null;
}

export const EMPTY_JOBS: JobsSnapshot = { job: null, run: null };

export type JobEvent =
  | { readonly type: "started"; readonly job: JobView; readonly run: RunView }
  | { readonly type: "phase"; readonly phase: JobPhase; readonly label: string; readonly at: number }
  | { readonly type: "project"; readonly project: RunView["project"] }
  | { readonly type: "step"; readonly step: StepView; readonly usage: Usage; readonly costUsd: number }
  | { readonly type: "action"; readonly turn: number; readonly name: string; readonly output: string }
  | { readonly type: "mark"; readonly mark: MarkView }
  | { readonly type: "explored"; readonly summary: ExploreSummary }
  | { readonly type: "judge"; readonly judge: JudgeView }
  | { readonly type: "locale"; readonly run: LocaleRun }
  | { readonly type: "touch"; readonly x: number; readonly y: number; readonly at: number }
  | { readonly type: "compose"; readonly compose: ComposeView }
  | { readonly type: "render"; readonly set: string; readonly locale: string; readonly render: RenderView }
  | { readonly type: "caption"; readonly locale: string; readonly screen: string; readonly caption: CaptionView }
  | { readonly type: "progress"; readonly done: number; readonly total: number }
  | { readonly type: "cancelling" }
  | { readonly type: "ended"; readonly status: "done" | "failed" | "cancelled"; readonly error?: string; readonly at: number };

export const isActive = (job: JobView | null | undefined): boolean => job?.status === "running" || job?.status === "cancelling";

function updateRun(state: JobsSnapshot, update: (run: RunView) => RunView): JobsSnapshot {
  return state.run ? { ...state, run: update(state.run) } : state;
}

function updateJob(state: JobsSnapshot, update: (job: JobView) => JobView): JobsSnapshot {
  return state.job ? { ...state, job: update(state.job) } : state;
}

export function applyJobEvent(state: JobsSnapshot, event: JobEvent): JobsSnapshot {
  switch (event.type) {
    case "started":
      return { job: event.job, run: event.run };
    case "phase":
      return updateJob(state, (job) => ({ ...job, phase: event.phase, phaseLabel: event.label, phaseAt: event.at }));
    case "project":
      return updateRun(state, (run) => ({ ...run, project: event.project }));
    case "step":
      return updateRun(state, (run) => ({
        ...run,
        steps: [...run.steps.filter((s) => s.turn !== event.step.turn), event.step],
        usage: event.usage,
        costUsd: event.costUsd,
      }));
    case "action":
      return updateRun(state, (run) => ({
        ...run,
        steps: run.steps.map((step) => {
          if (step.turn !== event.turn) return step;
          const index = step.calls.findIndex((c) => c.name === event.name && c.output === undefined);
          if (index < 0) return step;
          return { ...step, calls: step.calls.map((c, i) => (i === index ? { ...c, output: event.output } : c)) };
        }),
      }));
    case "mark":
      return updateRun(state, (run) => ({ ...run, marks: [...run.marks.filter((m) => m.name !== event.mark.name), event.mark] }));
    case "explored":
      return updateRun(state, (run) => ({ ...run, summary: event.summary }));
    case "judge":
      return updateRun(state, (run) => ({ ...run, judge: event.judge }));
    case "locale":
      return updateRun(state, (run) => {
        const exists = run.replays.some((r) => r.locale === event.run.locale);
        return {
          ...run,
          replays: exists ? run.replays.map((r) => (r.locale === event.run.locale ? event.run : r)) : [...run.replays, event.run],
        };
      });
    case "touch":
      return updateJob(state, (job) => ({ ...job, touch: { x: event.x, y: event.y, at: event.at } }));
    case "compose":
      return updateRun(state, (run) => ({ ...run, compose: event.compose }));
    case "render":
      return updateRun(state, (run) => {
        const compose = run.compose;
        const list = compose?.renders[event.set]?.[event.locale];
        if (!compose || !list) return run;
        const next = list.map((r) => (r.screen === event.render.screen ? event.render : r));
        return { ...run, compose: { ...compose, renders: { ...compose.renders, [event.set]: { ...compose.renders[event.set], [event.locale]: next } } } };
      });
    case "caption":
      return updateRun(state, (run) => {
        const compose = run.compose;
        if (!compose) return run;
        const byLocale = { ...compose.captions.byLocale, [event.locale]: { ...compose.captions.byLocale[event.locale], [event.screen]: event.caption } };
        return { ...run, compose: { ...compose, captions: { ...compose.captions, byLocale } } };
      });
    case "progress":
      return updateJob(state, (job) => ({ ...job, progress: { done: event.done, total: event.total } }));
    case "cancelling":
      return updateJob(state, (job) => ({ ...job, status: "cancelling" }));
    case "ended":
      return updateJob(state, (job) => ({
        ...job,
        status: event.status,
        endedAt: event.at,
        ...(event.error !== undefined && { error: event.error }),
      }));
  }
}

/** URL of a run file (a path from a MarkView or ShotView), served from the session's folder. */
export function artifactUrl(runId: string, path: string, version?: number | string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `/api/artifacts/${encodeURIComponent(runId)}/${encoded}${version !== undefined ? `?v=${encodeURIComponent(String(version))}` : ""}`;
}

/** The screens in their final order: the judge's ranking when there is one, else the explorer's. */
export function rankedScreens(run: RunView): Array<{ mark: MarkView; judged?: JudgedView; rank: number }> {
  const byName = new Map(run.marks.map((m) => [m.name, m]));
  const judged = run.judge && "ranking" in run.judge ? run.judge.ranking : [];
  const order = [
    ...judged.map((j) => j.name),
    ...(run.summary?.ranked ?? []),
    ...[...run.marks].sort((a, b) => b.score - a.score).map((m) => m.name),
  ].filter((name, i, all) => byName.has(name) && all.indexOf(name) === i);
  return order.map((name, i) => {
    const j = judged.find((x) => x.name === name);
    return { mark: byName.get(name)!, rank: i + 1, ...(j && { judged: j }) };
  });
}
