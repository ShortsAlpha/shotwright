/**
 * Selectors and the step executors shared by exploration and replay.
 *
 * Exploration records every action as a flow step first and then runs that step through the
 * same executor the replayer uses, so a replay on the same device and locale does exactly what
 * the exploration did.
 */
import type {
  DeviceDriver,
  ElementSelector,
  NormalizedPoint,
  NormalizedRect,
  Point,
  Rect,
  ScreenInfo,
  SwipeStep,
  TapStep,
  TypeTextStep,
} from "@shotwright/core";
import { center, isInteractive, overlayFrames, tappable, type FlatNode } from "./observe.ts";

/** Languages written right to left: the layout is mirrored, so recorded x positions are too. */
const RTL = new Set(["ar", "he", "fa", "ur", "yi", "ps", "sd", "ug", "dv", "ckb"]);

export function isRtlLanguage(language: string | undefined): boolean {
  return language !== undefined && RTL.has(language.split(/[-_]/)[0]!.toLowerCase());
}

/** How a step's target was found on replay. */
export type ResolvedVia = "id" | "structure" | "label";

export interface ResolveOptions {
  /** The recorded tap point; breaks ties between several matches. */
  readonly fallback?: NormalizedPoint;
  /** The layout is mirrored (right-to-left language): compare against mirrored frames and points. */
  readonly rtl?: boolean;
}

export function normalize(point: Point, screen: ScreenInfo): NormalizedPoint {
  const round = (v: number) => Math.round(Math.min(Math.max(v, 0), 1) * 10_000) / 10_000;
  return { x: round(point.x / screen.width), y: round(point.y / screen.height) };
}

export function denormalize(point: NormalizedPoint, screen: ScreenInfo): Point {
  return { x: point.x * screen.width, y: point.y * screen.height };
}

/** A frame in normalized screen coordinates, clipped to the screen. */
export function normalizeRect(frame: Rect, screen: ScreenInfo): NormalizedRect {
  const round = (v: number) => Math.round(Math.min(Math.max(v, 0), 1) * 10_000) / 10_000;
  const x1 = Math.min(Math.max(frame.x, 0), screen.width);
  const y1 = Math.min(Math.max(frame.y, 0), screen.height);
  const x2 = Math.min(Math.max(frame.x + frame.w, 0), screen.width);
  const y2 = Math.min(Math.max(frame.y + frame.h, 0), screen.height);
  return { x: round(x1 / screen.width), y: round(y1 / screen.height), w: round((x2 - x1) / screen.width), h: round((y2 - y1) / screen.height) };
}

export function denormalizeRect(rect: NormalizedRect, screen: ScreenInfo): Rect {
  return { x: rect.x * screen.width, y: rect.y * screen.height, w: rect.w * screen.width, h: rect.h * screen.height };
}

export function mirrorPoint(point: NormalizedPoint): NormalizedPoint {
  return { x: Math.round((1 - point.x) * 10_000) / 10_000, y: point.y };
}

export function mirrorRect(rect: NormalizedRect): NormalizedRect {
  return { ...rect, x: Math.max(0, Math.round((1 - rect.x - rect.w) * 10_000) / 10_000) };
}

/**
 * Stable selector for a node: identifier when unique, identifier + label when not, label alone
 * otherwise. Without a unique identifier the selector also records the node's structural
 * position (type, index among same-type siblings, normalized frame) when the screen is given,
 * so replay can find it in another language without the label.
 */
export function selectorFor(node: FlatNode, nodes: readonly FlatNode[], screen?: ScreenInfo): ElementSelector | undefined {
  const structure = screen ? { type: node.type, index: node.siblingIndex, frame: normalizeRect(node.frame, screen) } : undefined;
  if (node.identifier) {
    const sameId = nodes.filter((n) => n.identifier === node.identifier);
    if (sameId.length <= 1) return { id: node.identifier };
    const sameBoth = node.label ? sameId.filter((n) => n.label === node.label) : [];
    const withLabel = sameBoth.length === 1 ? { id: node.identifier, label: node.label! } : { id: node.identifier };
    return structure ? { ...withLabel, ...structure } : withLabel;
  }
  if (node.label) return structure ? { label: node.label, ...structure } : { label: node.label };
  return structure;
}

/** The selector to hand to a DeviceDriver: drivers know id, label and type, not our structural index or frame. */
export function driverSelector(selector: ElementSelector): ElementSelector {
  return {
    ...(selector.id !== undefined ? { id: selector.id } : {}),
    ...(selector.label !== undefined ? { label: selector.label } : {}),
    ...(selector.type !== undefined ? { type: selector.type } : {}),
  };
}

const usable = (n: FlatNode) => n.frame.w > 0 && n.frame.h > 0 && !n.inKeyboard;

/** Leading segment of a combined label ("Netflix, $15.49, Monthly" -> "Netflix"). */
const headOf = (label: string) => label.split(", ")[0]!;

/** Same type, same position among its siblings, and a frame near the recorded one. */
function structuralMatch(nodes: readonly FlatNode[], selector: ElementSelector, screen: ScreenInfo, rtl: boolean): FlatNode | undefined {
  if (selector.type === undefined || selector.index === undefined || selector.frame === undefined) return undefined;
  const recorded = selector.frame;
  const targets = rtl ? [mirrorRect(recorded), recorded] : [recorded];
  let best: FlatNode | undefined;
  let bestDistance = Infinity;
  for (const n of nodes) {
    if (!usable(n) || n.type !== selector.type || n.siblingIndex !== selector.index) continue;
    const r = normalizeRect(n.frame, screen);
    if (r.w === 0 || r.h === 0) continue;
    for (const t of targets) {
      const overlap = Math.min(r.x + r.w, t.x + t.w) > Math.max(r.x, t.x) && Math.min(r.y + r.h, t.y + t.h) > Math.max(r.y, t.y);
      const distance = Math.hypot(r.x + r.w / 2 - (t.x + t.w / 2), r.y + r.h / 2 - (t.y + t.h / 2));
      // Layouts drift a little between languages and launches (a card grows a line): allow 15 % of the screen.
      if ((overlap || distance <= 0.15) && distance < bestDistance) {
        best = n;
        bestDistance = distance;
      }
    }
  }
  return best;
}

/**
 * Finds the node a selector means, and how:
 * 1. by identifier (label, type and position break ties);
 * 2. by structure: same type, same index among its siblings, frame near the recorded one
 *    (mirrored for right-to-left languages). When the recorded label's leading name ("Netflix"
 *    of "Netflix, $15.49, ...") is visible on another element, the rows moved and the name wins;
 * 3. by exact label, then by the label's leading segment, which survives a language switch.
 * Among several matches, interactive and unobstructed elements win, then the one closest to the
 * recorded point.
 */
export function resolveTarget(
  nodes: readonly FlatNode[],
  selector: ElementSelector,
  screen: ScreenInfo,
  options: ResolveOptions = {},
): { node: FlatNode; via: ResolvedVia } | undefined {
  const rtl = options.rtl ?? false;
  const overlays = overlayFrames(nodes, screen);
  const near = options.fallback ?? (selector.frame ? { x: selector.frame.x + selector.frame.w / 2, y: selector.frame.y + selector.frame.h / 2 } : undefined);
  const pick = (all: FlatNode[]): FlatNode => {
    let candidates = all;
    const interactive = candidates.filter((n) => isInteractive(n.type));
    if (interactive.length > 0) candidates = interactive;
    const visible = candidates.filter((n) => tappable(n, overlays, screen));
    if (visible.length > 0) candidates = visible;
    if (!near || candidates.length === 1) return candidates[0]!;
    const target = denormalize(rtl ? mirrorPoint(near) : near, screen);
    const distance = (n: FlatNode) => Math.hypot(center(n.frame).x - target.x, center(n.frame).y - target.y);
    return candidates.reduce((best, n) => (distance(n) < distance(best) ? n : best));
  };

  if (selector.id !== undefined) {
    let candidates = nodes.filter((n) => usable(n) && n.identifier === selector.id);
    if (candidates.length === 0) return undefined;
    for (const narrow of [
      (n: FlatNode) => selector.label === undefined || n.label === selector.label,
      (n: FlatNode) => selector.type === undefined || n.type === selector.type,
      (n: FlatNode) => selector.index === undefined || n.siblingIndex === selector.index,
    ]) {
      const narrowed = candidates.filter(narrow);
      if (narrowed.length > 0) candidates = narrowed;
    }
    return { node: pick(candidates), via: "id" };
  }

  const label = selector.label;
  const exact = label !== undefined ? nodes.filter((n) => usable(n) && n.label === label) : [];
  // List rows combine a name with localized details ("Netflix, $15.49, Monthly, ..."): the leading
  // segment (often a brand or user-entered name) survives a language switch.
  const head = label !== undefined ? headOf(label) : undefined;
  const byHead =
    head !== undefined && head.length >= 3 && head !== label
      ? nodes.filter((n) => usable(n) && n.label !== undefined && (n.label === head || n.label.startsWith(`${head}, `)))
      : [];
  const structural = structuralMatch(nodes, selector, screen, rtl);
  if (structural) {
    if (label === undefined || structural.label === label) return { node: structural, via: "structure" };
    // The label is localized (no exact match). Keep the structural match unless the recorded name
    // is visible on another element: then the rows moved, and the name is the better guide.
    if (exact.length === 0 && (byHead.length === 0 || byHead.includes(structural))) return { node: structural, via: "structure" };
  }
  if (exact.length > 0) return { node: pick(exact), via: "label" };
  if (byHead.length > 0) return { node: pick(byHead), via: "label" };
  return undefined;
}

/** The node a selector means (see resolveTarget). */
export function resolveSelector(
  nodes: readonly FlatNode[],
  selector: ElementSelector,
  screen: ScreenInfo,
  fallback?: NormalizedPoint,
): FlatNode | undefined {
  return resolveTarget(nodes, selector, screen, fallback ? { fallback } : {})?.node;
}

/** Deepest node containing the point that has an identifier or label (interactive ones preferred). */
export function nodeAt(nodes: readonly FlatNode[], point: Point): FlatNode | undefined {
  const containing = nodes.filter(
    (n) =>
      !n.inKeyboard &&
      n.depth > 0 &&
      (n.identifier || n.label) &&
      point.x >= n.frame.x &&
      point.x <= n.frame.x + n.frame.w &&
      point.y >= n.frame.y &&
      point.y <= n.frame.y + n.frame.h,
  );
  if (containing.length === 0) return undefined;
  const area = (n: FlatNode) => n.frame.w * n.frame.h;
  const interactive = containing.filter((n) => isInteractive(n.type));
  const pool = interactive.length > 0 ? interactive : containing;
  return pool.reduce((best, n) => (area(n) < area(best) ? n : best));
}

/** The flow step for tapping a node (selector + normalized fallback at its centre). */
export function tapStepForNode(node: FlatNode, nodes: readonly FlatNode[], screen: ScreenInfo): TapStep | undefined {
  const target = selectorFor(node, nodes, screen);
  if (!target) return undefined;
  return { action: "tap", target, fallback: normalize(center(node.frame), screen) };
}

export interface ExecutedTap {
  /** id / structure / label: the target was found; fallback: the recorded point; point: a coordinate-only step. */
  readonly via: ResolvedVia | "fallback" | "point";
  readonly point: Point;
  readonly node?: FlatNode;
}

export interface PlanOptions {
  /** Mirror recorded x positions (right-to-left language). */
  readonly rtl?: boolean;
}

/**
 * Taps the element the step names, at its centre. Falls back to the recorded point when the
 * selector matches nothing (e.g. a localized label), or when it resolves to a large container
 * (a coordinate tap recorded against the nearest labelled ancestor). A coordinate-only step taps
 * its point. Recorded points are mirrored for right-to-left languages.
 */
export function planTap(step: TapStep, nodes: readonly FlatNode[], screen: ScreenInfo, options: PlanOptions = {}): ExecutedTap {
  const rtl = options.rtl ?? false;
  const recorded = (p: NormalizedPoint) => denormalize(rtl ? mirrorPoint(p) : p, screen);
  if (!step.target) {
    if (!step.point) throw new Error("tap step has neither a target nor a point");
    return { via: "point", point: recorded(step.point) };
  }
  const found = resolveTarget(nodes, step.target, screen, { ...(step.fallback ? { fallback: step.fallback } : {}), rtl });
  const node = found?.node;
  const screenArea = screen.width * screen.height;
  if (found && node && tappable(node, overlayFrames(nodes, screen), screen)) {
    const large = node.frame.w * node.frame.h > screenArea * 0.25;
    if (large && step.fallback) return { via: "fallback", point: recorded(step.fallback), node };
    return { via: found.via, point: center(node.frame), node };
  }
  if (node && !step.fallback) throw new Error(`tap target ${JSON.stringify(step.target)} is off screen or covered`);
  if (step.fallback) return { via: "fallback", point: recorded(step.fallback) };
  throw new Error(`tap target ${JSON.stringify(step.target)} not found`);
}

/**
 * The swipe that brings an off-screen (or bar-covered) node to the middle of the screen, or
 * undefined when it is already tappable. Swipes stop momentum, so the distance is exact.
 */
export function scrollIntoView(node: FlatNode, nodes: readonly FlatNode[], screen: ScreenInfo): SwipeStep | undefined {
  if (tappable(node, overlayFrames(nodes, screen), screen)) return undefined;
  const c = center(node.frame);
  const dy = c.y - screen.height / 2;
  const dx = c.x - screen.width / 2;
  const vertical = Math.abs(dy) >= Math.abs(dx);
  const delta = vertical ? dy / screen.height : dx / screen.width;
  const distance = Math.round(Math.min(Math.max(Math.abs(delta), 0.1), 0.7) * 100) / 100;
  const direction = vertical ? (delta > 0 ? "up" : "down") : delta > 0 ? "left" : "right";
  return { action: "swipe", direction, distance };
}

export async function performTap(
  driver: DeviceDriver,
  step: TapStep,
  nodes: readonly FlatNode[],
  screen: ScreenInfo,
  options: PlanOptions = {},
): Promise<ExecutedTap> {
  const plan = planTap(step, nodes, screen, options);
  await driver.tap({ x: Math.round(plan.point.x * 10) / 10, y: Math.round(plan.point.y * 10) / 10 });
  return plan;
}

/**
 * Start and end points of a swipe step: from `from` (or the centre of the target or screen),
 * `distance` of the target's (or screen's) size in `direction`. For right-to-left languages a
 * horizontal swipe is mirrored, like the layout.
 */
export function planSwipe(step: SwipeStep, nodes: readonly FlatNode[], screen: ScreenInfo, options: PlanOptions = {}): { from: Point; to: Point } {
  let area = { x: 0, y: 0, w: screen.width, h: screen.height };
  if (step.target) {
    const node = resolveSelector(nodes, step.target, screen);
    if (node) {
      // Clip to the screen so a tall scroll view swipes within its visible part.
      const x1 = Math.max(node.frame.x, 0);
      const y1 = Math.max(node.frame.y, 0);
      const x2 = Math.min(node.frame.x + node.frame.w, screen.width);
      const y2 = Math.min(node.frame.y + node.frame.h, screen.height);
      if (x2 > x1 && y2 > y1) area = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
  }
  const rtl = options.rtl ?? false;
  const flip = { left: "right", right: "left", up: "up", down: "down" } as const;
  const direction = rtl ? flip[step.direction] : step.direction;
  const distance = step.distance ?? 0.5;
  const span = { x: area.w * distance, y: area.h * distance };
  const clampX = (v: number) => Math.min(Math.max(v, 1), screen.width - 1);
  const clampY = (v: number) => Math.min(Math.max(v, 1), screen.height - 1);
  if (step.from) {
    const from = denormalize(rtl ? mirrorPoint(step.from) : step.from, screen);
    const to =
      direction === "up" ? { x: from.x, y: from.y - span.y }
      : direction === "down" ? { x: from.x, y: from.y + span.y }
      : direction === "left" ? { x: from.x - span.x, y: from.y }
      : { x: from.x + span.x, y: from.y };
    return { from, to: { x: clampX(to.x), y: clampY(to.y) } };
  }
  const c = center(area);
  const half = { x: span.x / 2, y: span.y / 2 };
  switch (direction) {
    case "up":
      return { from: { x: c.x, y: c.y + half.y }, to: { x: c.x, y: c.y - half.y } };
    case "down":
      return { from: { x: c.x, y: c.y - half.y }, to: { x: c.x, y: c.y + half.y } };
    case "left":
      return { from: { x: c.x + half.x, y: c.y }, to: { x: c.x - half.x, y: c.y } };
    case "right":
      return { from: { x: c.x - half.x, y: c.y }, to: { x: c.x + half.x, y: c.y } };
  }
}

export async function performSwipe(driver: DeviceDriver, step: SwipeStep, nodes: readonly FlatNode[], screen: ScreenInfo, options: PlanOptions = {}): Promise<void> {
  const { from, to } = planSwipe(step, nodes, screen, options);
  await driver.swipe({ from, to, durationMs: 300 });
}

/**
 * Types into the step's field. Drivers find fields by id or label; a field known only by its
 * structure (a text field with just a placeholder) is resolved here and tapped first.
 */
export async function performType(
  driver: DeviceDriver,
  step: TypeTextStep,
  nodes?: readonly FlatNode[],
  screen?: ScreenInfo,
  options: PlanOptions = {},
): Promise<void> {
  const target = step.target;
  if (target && target.id === undefined && target.label === undefined && nodes && screen) {
    const found = resolveTarget(nodes, target, screen, { rtl: options.rtl ?? false });
    if (found) {
      const c = center(found.node.frame);
      await driver.tap({ x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10 });
      await driver.typeText(step.text);
      return;
    }
  }
  await driver.typeText(step.text, target && (target.id !== undefined || target.label !== undefined) ? driverSelector(target) : undefined);
}

/** Converts a free from/to swipe (points) into a flow swipe step. */
export function swipeStepFromPoints(from: Point, to: Point, nodes: readonly FlatNode[], screen: ScreenInfo): SwipeStep {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const horizontal = Math.abs(dx) > Math.abs(dy);
  const direction = horizontal ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
  const container = nodeAt(
    nodes.filter((n) => n.identifier && ["scrollView", "collectionView", "table", "other", "group"].includes(n.type)),
    from,
  );
  const size = container
    ? horizontal ? Math.min(container.frame.w, screen.width) : Math.min(container.frame.h, screen.height)
    : horizontal ? screen.width : screen.height;
  const distance = Math.min(Math.max(Math.abs(horizontal ? dx : dy) / size, 0.1), 0.9);
  const step: SwipeStep = { action: "swipe", direction, distance: Math.round(distance * 100) / 100, from: normalize(from, screen) };
  return container?.identifier ? { ...step, target: { id: container.identifier } } : step;
}
