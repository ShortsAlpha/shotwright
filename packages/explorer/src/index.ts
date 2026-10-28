/**
 * @shotwright/explorer: model-agnostic exploration agent.
 *
 *   const result = await explore({ driver, provider: createProvider("spark"), bundleId, launchArgs });
 *   const replay = await replayFlow(driver, result.flow, { locale: { language: "de" }, screens: result.screens });
 *   const judged = await judgeScreens({ screens: [...] });
 *
 * See docs/spikes/explorer.md.
 */
export { explore } from "./explore.ts";
export type { ExploreOptions, ExploreEvent, ExplorationResult, StepLog } from "./explore.ts";
export { replayFlow, localeArgs, jaccard, structureSimilarity } from "./replay.ts";
export type { Locale, ReplayOptions, ReplayResult, ReplayShot, ReplayCheck, ReplayStepResult } from "./replay.ts";
export { judgeScreens } from "./judge.ts";
export type { JudgeOptions, JudgeResult, JudgeScreen, JudgedScreen } from "./judge.ts";
export { FlowRecorder } from "./recorder.ts";
export type { ScreenRecord, MarkedScreen, StateInfo } from "./recorder.ts";
export { observe, buildObservation, stableSource, downscale, flatten, selectElements } from "./observe.ts";
export type { Observation, ObservedElement, FlatNode, ObserveOptions } from "./observe.ts";
export { performTap, performSwipe, performType, planTap, planSwipe, resolveSelector, selectorFor } from "./actions.ts";
export { TOOLS, parseToolInput, parseJsonAction } from "./tools.ts";
export type { ToolSpec, ToolInput } from "./tools.ts";
export * from "./providers/index.ts";
