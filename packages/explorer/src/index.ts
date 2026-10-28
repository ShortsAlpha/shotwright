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
export type { ExploreOptions, ExploreEvent, ExploreStepEvent, ExplorationResult, StepLog } from "./explore.ts";
export { replayFlow, localeArgs, jaccard, structureSimilarity } from "./replay.ts";
export type { Locale, ReplayOptions, ReplayResult, ReplayShot, ReplayCheck, ReplayStepResult, ReplayStepEvent, StepVia } from "./replay.ts";
export { settleCapture, compareScreenshots } from "./capture.ts";
export type { CaptureSettleOptions, CaptureContext, SettledCapture } from "./capture.ts";
export { listScrollState, scrollToTop } from "./scroll.ts";
export type { ListScroll, ScrollToTopResult, ScrollToTopOptions } from "./scroll.ts";
export { applyPatches, patchesFromRepairs, saveRepairedFlow, flowHash } from "./repaired.ts";
export type { FlowPatch, RepairedFlowFile } from "./repaired.ts";
export { StepRepairer, outlineTarget } from "./repair.ts";
export type { RepairOptions, RepairRecord, RepairAttempt } from "./repair.ts";
export { judgeScreens } from "./judge.ts";
export type { JudgeOptions, JudgeResult, JudgeScreen, JudgedScreen } from "./judge.ts";
export { FlowRecorder } from "./recorder.ts";
export type { ScreenRecord, MarkedScreen, StateInfo } from "./recorder.ts";
export { observe, buildObservation, stableSource, downscale, flatten, selectElements, layoutKey } from "./observe.ts";
export type { Observation, ObservedElement, FlatNode, ObserveOptions } from "./observe.ts";
export { performTap, performSwipe, performType, planTap, planSwipe, resolveSelector, resolveTarget, selectorFor, isRtlLanguage } from "./actions.ts";
export type { ResolvedVia, ExecutedTap } from "./actions.ts";
export { TOOLS, parseToolInput, parseJsonAction } from "./tools.ts";
export type { ToolSpec, ToolInput } from "./tools.ts";
export * from "./providers/index.ts";
