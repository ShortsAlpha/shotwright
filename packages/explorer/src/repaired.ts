/**
 * Writes successful repairs back into the flow, as `flow.repaired.json` next to `flow.json` (the
 * original is never overwritten).
 *
 * - A tap whose target was repaired keeps its recorded label (the recording locale's) and takes
 *   the identifier, type, sibling index and frame of the element the model picked. Those are
 *   language-independent, so the next replay in any locale resolves the step without a model.
 *   Frames picked in a right-to-left locale are mirrored back.
 * - A screen repair (the flow was on the wrong screen before a screenshot) inserts the one action
 *   that fixed it before the screenshot's `waitFor`. Repairs that needed two actions are not
 *   written back: replaying both could do the wrong thing.
 *
 * The file is a valid flow (FlowSchema.parse ignores the extra keys) plus `repairs` (every patch,
 * with the locale it came from) and `basedOn` (a hash of the original flow). Each replay adds its
 * patches to the ones already there for the same original and rebuilds the file from the
 * original, so replays in several locales accumulate; the first working patch per step wins.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ElementSelector, Flow, FlowStep, NormalizedPoint, ScreenInfo, TapStep } from "@shotwright/core";
import { FlowSchema } from "@shotwright/core";
import { mirrorPoint, mirrorRect, normalize } from "./actions.ts";
import type { RepairRecord } from "./repair.ts";

export interface FlowPatch {
  /** Step index in the original flow. */
  readonly stepIndex: number;
  readonly kind: "tap" | "screen";
  /** e.g. "de". */
  readonly locale?: string;
  /** tap: the new target and fallback; screen: the step inserted before the screenshot (and its waitFor). */
  readonly target?: ElementSelector;
  readonly fallback?: NormalizedPoint;
  readonly insert?: FlowStep;
  readonly note?: string;
}

export interface RepairedFlowFile {
  readonly flow: Flow;
  readonly patches: readonly FlowPatch[];
  readonly path: string;
}

export function flowHash(flow: Flow): string {
  return createHash("sha1").update(JSON.stringify(flow.steps)).digest("hex").slice(0, 16);
}

/** The patches a replay's repairs suggest, against the original flow's step indices. */
export function patchesFromRepairs(flow: Flow, repairs: readonly RepairRecord[], context: { rtl: boolean; screen: ScreenInfo; locale?: string }): FlowPatch[] {
  const unmirrorPoint = (p: NormalizedPoint) => (context.rtl ? mirrorPoint(p) : p);
  const patches: FlowPatch[] = [];
  for (const record of repairs) {
    if (!record.ok) continue;
    const step = flow.steps[record.stepIndex];
    const acted = record.attempts.filter((a) => a.action !== "give_up" && a.action !== "no tool call" && !a.action.startsWith("Error"));
    const last = record.attempts.at(-1);
    const locale = context.locale !== undefined ? { locale: context.locale } : {};
    if (record.kind === "tap" && step?.action === "tap" && record.chosen) {
      const chosen = record.chosen;
      const frame = chosen.frame ? (context.rtl ? mirrorRect(chosen.frame) : chosen.frame) : undefined;
      const label = step.target?.label ?? chosen.label;
      const target: ElementSelector = {
        ...(chosen.id !== undefined ? { id: chosen.id } : {}),
        ...(label !== undefined && (chosen.id === undefined || chosen.label !== undefined) ? { label } : {}),
        ...(chosen.type !== undefined ? { type: chosen.type } : {}),
        ...(chosen.index !== undefined ? { index: chosen.index } : {}),
        ...(frame ? { frame } : {}),
      };
      // The frame is already in the recording's (left-to-right) layout.
      const fallback = frame ? { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 } : undefined;
      patches.push({ stepIndex: record.stepIndex, kind: "tap", ...locale, target, ...(fallback ? { fallback: roundPoint(fallback) } : {}) });
      continue;
    }
    if (record.kind === "screen" && acted.length === 1 && last?.verified) {
      let insert: FlowStep | undefined;
      if (record.chosen && last.action.startsWith("tap ")) {
        const frame = record.chosen.frame ? (context.rtl ? mirrorRect(record.chosen.frame) : record.chosen.frame) : undefined;
        const target: ElementSelector = { ...record.chosen, ...(frame ? { frame } : {}) };
        const fallback = last.point ? roundPoint(unmirrorPoint(normalize(last.point, context.screen))) : undefined;
        insert = { action: "tap", target, ...(fallback ? { fallback } : {}) } satisfies TapStep;
      } else if (last.action.startsWith("tap_at") && last.point) {
        insert = { action: "tap", point: roundPoint(unmirrorPoint(normalize(last.point, context.screen))) };
      } else if (last.action.startsWith("swipe ")) {
        const direction = last.action.slice(6) as "up" | "down" | "left" | "right";
        const flipped = context.rtl ? ({ left: "right", right: "left", up: "up", down: "down" } as const)[direction] : direction;
        if (["up", "down", "left", "right"].includes(direction)) insert = { action: "swipe", direction: flipped, distance: 0.5 };
      }
      if (insert) patches.push({ stepIndex: record.stepIndex, kind: "screen", ...locale, insert, note: `before screenshot step ${record.stepIndex}` });
    }
  }
  return patches;
}

const roundPoint = (p: NormalizedPoint) => ({ x: Math.round(p.x * 10_000) / 10_000, y: Math.round(p.y * 10_000) / 10_000 });

/** The original flow with the patches applied (the first patch per step and kind wins). */
export function applyPatches(original: Flow, patches: readonly FlowPatch[]): Flow {
  const steps: FlowStep[] = original.steps.map((s) => ({ ...s }) as FlowStep);
  const seen = new Set<string>();
  const unique = patches.filter((p) => {
    const key = `${p.kind}:${p.stepIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const patch of unique) {
    if (patch.kind !== "tap" || !patch.target) continue;
    const step = steps[patch.stepIndex];
    if (step?.action !== "tap") continue;
    steps[patch.stepIndex] = { ...step, target: patch.target, ...(patch.fallback ? { fallback: patch.fallback } : {}) };
  }
  // Insertions from the end, so earlier indices stay valid.
  const inserts = unique.filter((p) => p.kind === "screen" && p.insert).sort((a, b) => b.stepIndex - a.stepIndex);
  for (const patch of inserts) {
    let at = patch.stepIndex;
    if (steps[at - 1]?.action === "waitFor") at--;
    steps.splice(at, 0, patch.insert!);
  }
  return FlowSchema.parse({ ...original, steps });
}

/**
 * Adds this replay's patches to `<dir>/flow.repaired.json` (rebuilt from `original`) and returns
 * the result; undefined when there is nothing to write.
 */
export function saveRepairedFlow(dir: string, original: Flow, patches: readonly FlowPatch[]): RepairedFlowFile | undefined {
  const path = join(dir, "flow.repaired.json");
  const basedOn = flowHash(original);
  let previous: FlowPatch[] = [];
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { basedOn?: string; repairs?: FlowPatch[] };
      if (parsed.basedOn === basedOn && Array.isArray(parsed.repairs)) previous = parsed.repairs;
    } catch {
      // unreadable: start over from the original
    }
  }
  const all = [...previous, ...patches];
  if (all.length === 0) return undefined;
  if (patches.length === 0) return undefined; // nothing new
  const flow = applyPatches(original, all);
  writeFileSync(path, JSON.stringify({ ...flow, basedOn, repairs: all }, null, 2));
  return { flow, patches: all, path };
}
