/**
 * Replays a recorded flow on any DeviceDriver, in any locale, and checks that every screenshot
 * step reached the screen the exploration marked:
 * - the flow's own `waitFor` anchor (an identifier only that screen has) must appear,
 * - the screenshot step's `expect` record (identifiers that must be visible, the element type
 *   sequence) must match, and
 * - when the exploration's screen records are passed, the visible identifiers and the element
 *   type sequence (both locale-independent) must be similar to the recorded ones.
 *
 * Taps resolve by identifier, then by structure (type, position among siblings, frame), then by
 * label. With `repair`, a target that is not found, or a screenshot step on the wrong screen, is
 * repaired by a model (repair.ts) instead of tapping the recorded point blindly; successful
 * repairs are written back to `flow.repaired.json` next to the flow (repaired.ts).
 *
 * Screenshots are taken after capture settling (capture.ts): a stable tree and two near-identical
 * screenshots, capped at 4 s. A screen recorded at the top of its list (`expect.atTop`) is
 * scrolled back there first if something left it scrolled.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DeviceDriver, ElementSelector, Flow, ScreenInfo, ScreenshotStep, TapStep, UISnapshot } from "@shotwright/core";
import { isAbortError, sleep, throwIfAborted } from "./abort.ts";
import { isRtlLanguage, performSwipe, performType, planTap, resolveTarget, scrollIntoView, type ExecutedTap } from "./actions.ts";
import { settleCapture, type CaptureSettleOptions } from "./capture.ts";
import { flatten, selectElements, stableIdentifiers, stableSource, type FlatNode, type Observation } from "./observe.ts";
import type { ScreenRecord } from "./recorder.ts";
import { StepRepairer, type RepairOptions, type RepairRecord } from "./repair.ts";
import { patchesFromRepairs, saveRepairedFlow, type FlowPatch } from "./repaired.ts";
import { listScrollState, scrollToTop } from "./scroll.ts";

export type { RepairOptions, RepairRecord, RepairAttempt } from "./repair.ts";

export interface Locale {
  /** e.g. "de", "ja", "zh-Hans". */
  readonly language: string;
  /** e.g. "DE"; defaults to the language's usual region for a few common languages. */
  readonly region?: string;
}

export interface ReplayOptions {
  readonly locale?: Locale;
  /** Replaces the launch arguments recorded in the flow. */
  readonly launchArgs?: readonly string[];
  /** Appended to the launch arguments. */
  readonly extraLaunchArgs?: readonly string[];
  /** The exploration's screen records, to verify each screenshot (flows with `expect` records verify themselves). */
  readonly screens?: readonly ScreenRecord[];
  /** Writes <name>.png here. */
  readonly outDir?: string;
  /** How long to wait for a tap target with an identifier to appear. Default 8 s. */
  readonly findTimeoutMs?: number;
  readonly stopOnError?: boolean;
  /**
   * Repair broken steps with a model. Off when omitted. `{}` or `{ provider: "spark" }` means Muse
   * Spark 1.3, 2 model calls per step, $0.10 per replay; `{ provider: "open" }` uses Muse Spark
   * Open on Baseten (free). Without `referenceImage`, the screenshots the steps were recorded on
   * are loaded from the run directory (`runDir`, see below).
   */
  readonly repair?: RepairOptions;
  /**
   * The exploration's output directory (explore's `outDir`: exploration.json, flow.json,
   * steps/NNN.jpg). Repair reads its reference screenshots there and successful repairs are
   * written to `flow.repaired.json` in it. Default: the nearest directory above `outDir` (up to
   * three levels) that has an exploration.json, so `outDir: <run>/replay/<locale>` just works.
   */
  readonly runDir?: string;
  /**
   * For each flow step, the exploration observation it was recorded on (ExplorationResult.stepSources).
   * Default: read from `<runDir>/exploration.json` when its flow has the same steps.
   */
  readonly stepSources?: ReadonlyArray<number | null>;
  /** Write successful repairs to `<runDir>/flow.repaired.json`. Default true (needs a run directory). */
  readonly saveRepairs?: boolean;
  /** Capture settling before each screenshot (see capture.ts). Default on, 4 s cap; `false` turns it off. */
  readonly settle?: CaptureSettleOptions | false;
  /** After every step, with its result (and the screenshot for screenshot steps). */
  readonly onStep?: (event: ReplayStepEvent) => void;
  /** Stops the replay before the next step (a device call in flight finishes); the result has `aborted: true`. */
  readonly signal?: AbortSignal;
  readonly log?: (message: string) => void;
}

/** `onStep`: one finished step. */
export interface ReplayStepEvent extends ReplayStepResult {
  /** Steps in the flow. */
  readonly total: number;
  /** "miss": a missing anchor left to the screenshot step's repair. */
  readonly status: "ok" | "miss" | "failed";
  readonly locale: Locale | undefined;
  /** Screenshot steps: the captured screenshot (also in `ReplayResult.screenshots`). */
  readonly shot?: ReplayShot;
}

export interface ReplayCheck {
  readonly anchor?: { id: string; found: boolean };
  /** `expect.ids` that were not visible. */
  readonly missingIds?: readonly string[];
  readonly identifierSimilarity?: number;
  readonly structureSimilarity?: number;
}

export interface ReplayShot {
  readonly name: string;
  readonly png: Uint8Array;
  readonly file?: string;
  readonly verified: boolean;
  readonly checks: ReplayCheck;
  /** Reached the expected screen only after a model repair. */
  readonly repaired?: boolean;
  /** Capture settling: screenshots taken, time waited, and whether the picture settled before the cap. */
  readonly capture?: { readonly frames: number; readonly waitedMs: number; readonly settled: boolean };
  /** The list was scrolled back to its top before the screenshot (`expect.atTop`). */
  readonly scrolledToTop?: boolean;
}

/** How a tap step was carried out: target found by id, structure or label; by a model repair; at the recorded point; or a coordinate-only step. */
export type StepVia = ExecutedTap["via"] | "repair";

export interface ReplayStepResult {
  readonly index: number;
  readonly action: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail?: string;
  /** Taps: how the target was found. */
  readonly via?: StepVia;
  /** Set when a model repaired (or tried to repair) this step. */
  readonly repair?: RepairRecord;
}

export interface ReplayResult {
  readonly ok: boolean;
  readonly locale: Locale | undefined;
  readonly launchArgs: readonly string[];
  readonly screenshots: ReplayShot[];
  readonly steps: ReplayStepResult[];
  readonly totalMs: number;
  /** Every repair attempted in this replay. */
  readonly repairs: RepairRecord[];
  readonly repairCostUsd: number;
  /** The signal fired; the replay stopped early. */
  readonly aborted?: boolean;
  /** The flow with every repair so far written back (also saved as `repairedFlowFile`). */
  readonly repairedFlow?: Flow;
  readonly repairedFlowFile?: string;
  /** This replay's patches (see repaired.ts). */
  readonly patches?: FlowPatch[];
}

const DEFAULT_REGION: Record<string, string> = {
  en: "US", de: "DE", ja: "JP", fr: "FR", es: "ES", it: "IT", ko: "KR", nl: "NL", pl: "PL", pt: "BR",
  ru: "RU", sv: "SE", tr: "TR", ar: "SA", hi: "IN", "zh-Hans": "CN",
};

/** `-AppleLanguages (de) -AppleLocale de_DE`. */
export function localeArgs(locale: Locale): string[] {
  const region = locale.region ?? DEFAULT_REGION[locale.language] ?? "US";
  const base = locale.language.split("-")[0];
  return ["-AppleLanguages", `(${locale.language})`, "-AppleLocale", `${base}_${region}`];
}

function lcs(a: readonly string[], b: readonly string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(row[j]!, row[j - 1]!);
      prev = tmp;
    }
  }
  return row[b.length]!;
}

export function structureSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  return (2 * lcs(a, b)) / (a.length + b.length);
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let both = 0;
  for (const x of A) if (B.has(x)) both++;
  return both / (A.size + B.size - both);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** type|id|label|selected per node: changes when the screen does. */
const treeKey = (nodes: readonly FlatNode[]) => nodes.map((n) => `${n.type}|${n.identifier ?? ""}|${n.label ?? ""}|${n.selected ? 1 : 0}`).join("\n");

const describeTarget = (selector: ElementSelector) =>
  [selector.type, selector.label ? `"${selector.label.slice(0, 60)}"` : undefined, selector.id ? `#${selector.id}` : undefined].filter(Boolean).join(" ");

/** The nearest directory at or above `start` (up to `levels` up) with an exploration.json. */
function findRunDir(start: string | undefined, levels = 3): string | undefined {
  let dir = start;
  for (let i = 0; dir && i <= levels; i++) {
    if (existsSync(join(dir, "exploration.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/** stepSources from `<runDir>/exploration.json`, when its flow has the same steps as `flow`. */
function loadStepSources(runDir: string, flow: Flow): ReadonlyArray<number | null> | undefined {
  try {
    const exploration = JSON.parse(readFileSync(join(runDir, "exploration.json"), "utf8")) as { flow?: Flow; stepSources?: Array<number | null> };
    const shape = (f: Flow | undefined) => f?.steps.map((s) => s.action).join(",");
    if (exploration.stepSources && shape(exploration.flow) === shape(flow)) return exploration.stepSources;
  } catch {
    // no exploration.json, or unreadable
  }
  return undefined;
}

export async function replayFlow(driver: DeviceDriver, flow: Flow, options: ReplayOptions = {}): Promise<ReplayResult> {
  const log = options.log ?? (() => undefined);
  const signal = options.signal;
  const settle = options.settle === false ? undefined : (options.settle ?? {});
  const started = Date.now();
  const screen: ScreenInfo = await driver.screen();
  const steps: ReplayStepResult[] = [];
  const screenshots: ReplayShot[] = [];
  const findTimeout = options.findTimeoutMs ?? 8_000;
  const rtl = isRtlLanguage(options.locale?.language);
  let bundleId = "";
  let launchArgs: string[] = [];
  let lastAnchor: ElementSelector | undefined;
  let failed = false;
  if (options.outDir) mkdirSync(options.outDir, { recursive: true });
  const localeText = options.locale
    ? `${options.locale.language}${options.locale.region ? ` (${options.locale.region})` : ""}, ${rtl ? "right to left (mirrored layout)" : "left to right"}`
    : "the recording's own language";
  const runDir = options.runDir ?? findRunDir(options.outDir);
  let repairOptions = options.repair;
  if (repairOptions && !repairOptions.referenceImage && runDir) {
    // Repair references: the screenshot each step was recorded on (<runDir>/steps/NNN.jpg).
    const sources = options.stepSources ?? loadStepSources(runDir, flow);
    log(sources ? `  repair references: ${join(runDir, "steps")}` : `  repair references: none (the flow's steps differ from ${join(runDir, "exploration.json")})`);
    if (sources) {
      repairOptions = {
        ...repairOptions,
        referenceImage: (stepIndex: number) => {
          const at = sources[stepIndex];
          if (at === null || at === undefined) return undefined;
          try {
            return new Uint8Array(readFileSync(join(runDir, "steps", `${String(at).padStart(3, "0")}.jpg`)));
          } catch {
            return undefined;
          }
        },
      };
    }
  }
  const repairer = repairOptions
    ? new StepRepairer(repairOptions, { driver, screen, bundleId: () => bundleId, localeText, rtl, log, ...(signal ? { signal } : {}) })
    : undefined;

  const snapshotNodes = async (): Promise<{ snapshot: UISnapshot; nodes: FlatNode[] }> => {
    throwIfAborted(signal);
    const snapshot = await stableSource(driver, bundleId);
    return { snapshot, nodes: flatten(snapshot.tree) };
  };

  /** Waits until the selector resolves. Identifiers are locale-independent, so keep polling for them; anything else is given up on after one stable look. */
  const find = async (selector: ElementSelector, timeoutMs: number, fallback?: TapStep["fallback"]) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { nodes } = await snapshotNodes();
      const found = resolveTarget(nodes, selector, screen, { ...(fallback ? { fallback } : {}), rtl });
      if (found || selector.id === undefined || Date.now() > deadline) return { found, nodes };
      await sleep(400, signal);
    }
  };

  /** Checks a screenshot step against its anchor, its `expect` record and the exploration's screen record. */
  const checkScreen = async (step: ScreenshotStep, anchor: ElementSelector | undefined) => {
    const { nodes, snapshot } = await snapshotNodes();
    const record = options.screens?.find((s) => s.name === step.name);
    const identifiers = stableIdentifiers(nodes, screen);
    const structure = selectElements(nodes, screen).map((n) => n.type);
    const expectedStructure = step.expect?.structure ?? record?.structure;
    const missing = (step.expect?.ids ?? []).filter((id) => !identifiers.includes(id) && !nodes.some((n) => n.identifier === id && n.frame.w > 0));
    const anchorFound = anchor ? resolveTarget(nodes, anchor, screen, { rtl }) !== undefined : undefined;
    const checks: ReplayCheck = {
      ...(anchor && anchorFound !== undefined ? { anchor: { id: anchor.id ?? anchor.label ?? "", found: anchorFound } } : {}),
      ...(step.expect ? { missingIds: missing } : {}),
      ...(record && record.identifiers.length > 0 ? { identifierSimilarity: round2(jaccard(record.identifiers, identifiers)) } : {}),
      ...(expectedStructure ? { structureSimilarity: round2(structureSimilarity(expectedStructure, structure)) } : {}),
    };
    const problems: string[] = [];
    if (snapshot.state !== "foreground") problems.push(`the app is not in the foreground (${snapshot.state})`);
    if (checks.anchor && !checks.anchor.found) problems.push(`#${checks.anchor.id} is missing`);
    if (missing.length > 0) problems.push(`${missing.map((m) => `#${m}`).join(", ")} not visible`);
    if ((checks.structureSimilarity ?? 1) < 0.6) problems.push(`the layout differs (similarity ${checks.structureSimilarity})`);
    if ((checks.identifierSimilarity ?? 1) < 0.5) problems.push(`the visible identifiers differ (similarity ${checks.identifierSimilarity})`);
    return { verified: problems.length === 0, checks, problems, nodes };
  };

  /** What should be true after the tap at `index`, as text for the model and as a check. */
  const expectationAfter = (index: number): { text: string; check: (before: Observation) => Promise<boolean> } => {
    const next = flow.steps[index + 1];
    if (next?.action === "waitFor") {
      return {
        text: `the element ${describeTarget(next.target)} appears`,
        check: async () => (await find(next.target, 3_000)).found !== undefined,
      };
    }
    if (next?.action === "screenshot") {
      return {
        text: `the screen "${next.name}"${next.expect?.title ? ` (title "${next.expect.title}" when recorded)` : ""} appears`,
        check: async () => (await checkScreen(next, undefined)).verified,
      };
    }
    if ((next?.action === "tap" || next?.action === "typeText") && next.target) {
      const target = next.target;
      return {
        text: `the next step's target, ${describeTarget(target)}, can be found`,
        check: async (before) => {
          const { found, nodes } = await find(target, 1_500);
          return found !== undefined && treeKey(nodes) !== treeKey(before.nodes);
        },
      };
    }
    return {
      text: "the screen changes",
      check: async (before) => treeKey((await snapshotNodes()).nodes) !== treeKey(before.nodes),
    };
  };

  let aborted = false;
  for (const [index, step] of flow.steps.entries()) {
    if (failed && options.stopOnError) break;
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    const t0 = Date.now();
    const record = (ok: boolean, detail?: string, extra: { via?: StepVia; repair?: RepairRecord; soft?: boolean; shot?: ReplayShot } = {}) => {
      const result: ReplayStepResult = {
        index,
        action: step.action,
        ok,
        ms: Date.now() - t0,
        ...(detail ? { detail } : {}),
        ...(extra.via ? { via: extra.via } : {}),
        ...(extra.repair ? { repair: extra.repair } : {}),
      };
      steps.push(result);
      log(`  ${String(index).padStart(2)} ${step.action.padEnd(10)} ${ok ? "ok  " : extra.soft ? "miss" : "FAIL"} ${Date.now() - t0} ms${extra.via ? ` [${extra.via}]` : ""}${detail ? `  ${detail}` : ""}`);
      if (!ok && !extra.soft) failed = true;
      try {
        options.onStep?.({
          ...result,
          total: flow.steps.length,
          status: ok ? "ok" : extra.soft ? "miss" : "failed",
          locale: options.locale,
          ...(extra.shot ? { shot: extra.shot } : {}),
        });
      } catch (error) {
        log(`  onStep threw: ${(error as Error).message}`);
      }
    };
    try {
      switch (step.action) {
        case "launch": {
          bundleId = step.bundleId;
          launchArgs = [...(options.launchArgs ?? step.args), ...(options.extraLaunchArgs ?? []), ...(options.locale ? localeArgs(options.locale) : [])];
          try {
            await driver.launch({ bundleId, args: launchArgs });
            record(true);
          } catch (error) {
            // A launch that times out while waiting for a stable layout has often launched anyway
            // (a slow first snapshot on a busy Mac): check before giving up, then retry once.
            const why = (error as Error).message.slice(0, 160);
            const up = await stableSource(driver, bundleId, 20_000).then((s) => s.state === "foreground", () => false);
            if (up) {
              record(true, `launch reported "${why}", but the app is up`);
            } else {
              log(`  launch failed (${why}); retrying once`);
              await driver.launch({ bundleId, args: launchArgs });
              record(true, `relaunched after "${why}"`);
            }
          }
          break;
        }
        case "tap": {
          const target = step.target;
          if (!target) {
            const plan = planTap(step, [], screen, { rtl });
            await driver.tap({ x: Math.round(plan.point.x * 10) / 10, y: Math.round(plan.point.y * 10) / 10 });
            record(true, `at (${Math.round(plan.point.x)},${Math.round(plan.point.y)})`, { via: "point" });
            break;
          }
          let { found, nodes } = await find(target, target.id !== undefined ? findTimeout : 0, step.fallback);
          // A target that exists but is scrolled away (or under the tab bar) is scrolled into view
          // instead of tapping the recorded point, which would hit whatever is there now.
          let scrolls = 0;
          for (; found && scrolls < 4; scrolls++) {
            const scroll = scrollIntoView(found.node, nodes, screen);
            if (!scroll) break;
            await performSwipe(driver, scroll, nodes, screen);
            ({ found, nodes } = await find(target, 0, step.fallback));
          }
          const scrolled = scrolls ? ` after ${scrolls} scroll(s)` : "";
          if (!found && repairer?.available) {
            const expectation = expectationAfter(index);
            const repair = await repairer.repairTap(index, step, expectation.text, expectation.check);
            if (repair.ok) {
              const a = repair.attempts.at(-1);
              record(true, `${describeTarget(target)} -> ${a?.action ?? "?"}${a?.element?.label ? ` "${a.element.label.slice(0, 50)}"` : ""} ($${repair.costUsd.toFixed(4)})`, { via: "repair", repair });
              break;
            }
            if (repair.acted || !step.fallback) {
              record(false, `${describeTarget(target)} not found; repair failed${repair.note ? ` (${repair.note})` : ""}`, { via: "repair", repair });
              break;
            }
            // The model did not act (gave up, or no budget): the recorded point is all that is left.
            const plan = planTap(step, nodes, screen, { rtl });
            await driver.tap({ x: Math.round(plan.point.x * 10) / 10, y: Math.round(plan.point.y * 10) / 10 });
            record(true, `${describeTarget(target)} not found, repair did not act; recorded point (${Math.round(plan.point.x)},${Math.round(plan.point.y)})`, { via: "fallback", repair });
            break;
          }
          const plan = planTap(step, nodes, screen, { rtl });
          await driver.tap({ x: Math.round(plan.point.x * 10) / 10, y: Math.round(plan.point.y * 10) / 10 });
          const where = `(${Math.round(plan.point.x)},${Math.round(plan.point.y)})`;
          record(true, `${describeTarget(target)}${plan.node?.label && plan.node.label !== target.label ? ` = "${plan.node.label.slice(0, 40)}"` : ""} at ${where}${scrolled}`, { via: plan.via });
          break;
        }
        case "swipe": {
          const { nodes } = await snapshotNodes();
          await performSwipe(driver, step, nodes, screen, { rtl });
          record(true, `${step.direction} ${step.distance}`);
          break;
        }
        case "typeText": {
          const { nodes } = step.target && step.target.id === undefined && step.target.label === undefined ? await snapshotNodes() : { nodes: undefined };
          await performType(driver, step, nodes, screen, { rtl });
          record(true);
          break;
        }
        case "scrollToTop": {
          const result = await scrollToTop(driver, screen, bundleId, { log });
          record(result.via !== "failed", result.via === "swipes" ? `${result.swipes} drag(s)` : result.via);
          break;
        }
        case "waitFor": {
          const { found } = await find(step.target, step.timeoutMs);
          lastAnchor = step.target;
          // A missing anchor right before a screenshot is left to the screenshot step, which can repair.
          const soft = !found && repairer !== undefined && flow.steps[index + 1]?.action === "screenshot";
          record(found !== undefined, `${describeTarget(step.target)}${soft ? " missing; the screenshot step repairs" : ""}`, { soft });
          break;
        }
        case "screenshot": {
          let result = await checkScreen(step, lastAnchor);
          let repair: RepairRecord | undefined;
          if (!result.verified && repairer?.available) {
            const ids = [...new Set([...(lastAnchor?.id ? [lastAnchor.id] : []), ...(step.expect?.ids ?? [])])];
            const expected = { ...(step.expect?.title ? { title: step.expect.title } : {}), ids, problems: result.problems };
            const anchor = lastAnchor;
            repair = await repairer.repairScreen(index, step, expected, async () => {
              result = await checkScreen(step, anchor);
              return result.verified;
            });
          }
          // Recorded at the top of its list, now scrolled (a tab kept an offset, or a scroll into
          // view on the way): scroll back so the screenshot matches the recording.
          let scrolledToTop = false;
          if (step.expect?.atTop) {
            const state = listScrollState(result.nodes, screen);
            if (state?.root && state.scrolled) {
              const moved = await scrollToTop(driver, screen, bundleId, { log });
              scrolledToTop = moved.changed;
              log(`     scrolled the list back to the top before "${step.name}" (${moved.via}, ${moved.ms} ms)`);
              if (moved.changed) result = await checkScreen(step, lastAnchor);
            }
          }
          let png: Uint8Array;
          let capture: ReplayShot["capture"];
          if (settle) {
            const settled = await settleCapture(driver, { bundleId, log, label: `"${step.name}"`, ...(signal ? { signal } : {}) }, settle);
            png = settled.png;
            capture = { frames: settled.frames, waitedMs: settled.waitedMs, settled: settled.settled };
          } else {
            png = await driver.screenshot();
          }
          let file: string | undefined;
          if (options.outDir) {
            file = join(options.outDir, `${step.name}.png`);
            writeFileSync(file, png);
          }
          const repaired = repair?.ok === true;
          const shot: ReplayShot = {
            name: step.name,
            png,
            verified: result.verified,
            checks: result.checks,
            ...(file ? { file } : {}),
            ...(repaired ? { repaired } : {}),
            ...(capture ? { capture } : {}),
            ...(scrolledToTop ? { scrolledToTop } : {}),
          };
          screenshots.push(shot);
          lastAnchor = undefined;
          const captureNote = capture ? ` capture ${capture.frames} frames ${capture.waitedMs} ms${capture.settled ? "" : " (cap hit)"}` : "";
          record(result.verified, `${step.name} ${JSON.stringify(result.checks)}${captureNote}${repair ? ` repair ${repair.ok ? "ok" : "failed"} ($${repair.costUsd.toFixed(4)})` : ""}`, {
            ...(repair ? { repair, via: "repair" as const } : {}),
            shot,
          });
          break;
        }
      }
    } catch (error) {
      if (isAbortError(error, signal)) {
        aborted = true;
        log(`  ${String(index).padStart(2)} ${step.action.padEnd(10)} aborted`);
        break;
      }
      record(false, (error as Error).message.slice(0, 300));
    }
  }

  // Successful repairs go back into the flow (flow.repaired.json next to flow.json).
  const repairs = repairer?.records ?? [];
  let repairedFlow: Flow | undefined;
  let repairedFlowFile: string | undefined;
  let patches: FlowPatch[] | undefined;
  if (repairs.some((r) => r.ok)) {
    patches = patchesFromRepairs(flow, repairs, { rtl, screen, ...(options.locale ? { locale: options.locale.language } : {}) });
    if (patches.length > 0 && runDir && options.saveRepairs !== false) {
      try {
        const saved = saveRepairedFlow(runDir, flow, patches);
        if (saved) {
          repairedFlow = saved.flow;
          repairedFlowFile = saved.path;
          log(`  wrote ${patches.length} repair(s) back to ${saved.path} (${saved.patches.length} in total)`);
        }
      } catch (error) {
        log(`  could not write the repaired flow: ${(error as Error).message}`);
      }
    }
  }

  return {
    ok: !aborted && !failed && screenshots.length === flow.steps.filter((s) => s.action === "screenshot").length && screenshots.every((s) => s.verified),
    locale: options.locale,
    launchArgs,
    screenshots,
    steps,
    totalMs: Date.now() - started,
    repairs,
    repairCostUsd: repairer?.costUsd ?? 0,
    ...(aborted ? { aborted } : {}),
    ...(repairedFlow ? { repairedFlow } : {}),
    ...(repairedFlowFile ? { repairedFlowFile } : {}),
    ...(patches ? { patches } : {}),
  };
}
