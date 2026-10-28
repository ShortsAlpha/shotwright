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
  Point,
  ScreenInfo,
  SwipeStep,
  TapStep,
  TypeTextStep,
} from "@shotwright/core";
import { center, isInteractive, overlayFrames, tappable, type FlatNode } from "./observe.ts";

/** Stable selector for a node: identifier when unique, identifier + label when not, label alone otherwise. */
export function selectorFor(node: FlatNode, nodes: readonly FlatNode[]): ElementSelector | undefined {
  if (node.identifier) {
    const sameId = nodes.filter((n) => n.identifier === node.identifier);
    if (sameId.length <= 1 || !node.label) return { id: node.identifier };
    const sameBoth = sameId.filter((n) => n.label === node.label);
    return sameBoth.length === 1 ? { id: node.identifier, label: node.label } : { id: node.identifier };
  }
  if (node.label) return { label: node.label };
  return undefined;
}

export function normalize(point: Point, screen: ScreenInfo): NormalizedPoint {
  const round = (v: number) => Math.round(Math.min(Math.max(v, 0), 1) * 10_000) / 10_000;
  return { x: round(point.x / screen.width), y: round(point.y / screen.height) };
}

export function denormalize(point: NormalizedPoint, screen: ScreenInfo): Point {
  return { x: point.x * screen.width, y: point.y * screen.height };
}

const matches = (node: FlatNode, selector: ElementSelector) =>
  (selector.id === undefined || node.identifier === selector.id) &&
  (selector.label === undefined || node.label === selector.label) &&
  node.frame.w > 0 &&
  node.frame.h > 0 &&
  !node.inKeyboard;

/**
 * Finds the node a selector means. Among several matches, interactive elements win, then the one
 * closest to the recorded fallback point. With identifier + label and no exact match (the label
 * is localized), the identifier alone is tried.
 */
export function resolveSelector(
  nodes: readonly FlatNode[],
  selector: ElementSelector,
  screen: ScreenInfo,
  fallback?: NormalizedPoint,
): FlatNode | undefined {
  let candidates = nodes.filter((n) => matches(n, selector));
  if (candidates.length === 0 && selector.id !== undefined && selector.label !== undefined) {
    candidates = nodes.filter((n) => matches(n, { id: selector.id! }));
  }
  if (candidates.length === 0 && selector.id === undefined && selector.label !== undefined) {
    // List rows combine a name with localized details ("Netflix, $15.49, Monthly, ..."): the leading
    // segment (often a brand or user-entered name) survives a language switch.
    const head = selector.label.split(", ")[0]!;
    if (head.length >= 3 && head !== selector.label) {
      candidates = nodes.filter((n) => !n.inKeyboard && n.frame.w > 0 && n.label !== undefined && (n.label === head || n.label.startsWith(`${head}, `)));
    }
  }
  if (candidates.length === 0) return undefined;
  const interactive = candidates.filter((n) => isInteractive(n.type));
  if (interactive.length > 0) candidates = interactive;
  const overlays = overlayFrames(nodes, screen);
  const visible = candidates.filter((n) => tappable(n, overlays, screen));
  if (visible.length > 0) candidates = visible;
  if (!fallback || candidates.length === 1) return candidates[0];
  const target = denormalize(fallback, screen);
  const distance = (n: FlatNode) => Math.hypot(center(n.frame).x - target.x, center(n.frame).y - target.y);
  return candidates.reduce((best, n) => (distance(n) < distance(best) ? n : best));
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
  const target = selectorFor(node, nodes);
  if (!target) return undefined;
  return { action: "tap", target, fallback: normalize(center(node.frame), screen) };
}

export interface ExecutedTap {
  readonly via: "selector" | "fallback";
  readonly point: Point;
  readonly node?: FlatNode;
}

/**
 * Taps the element the step names, at its centre. Falls back to the recorded point when the
 * selector matches nothing (e.g. a localized label), or when it resolves to a large container
 * (a coordinate tap recorded against the nearest labelled ancestor).
 */
export function planTap(step: TapStep, nodes: readonly FlatNode[], screen: ScreenInfo): ExecutedTap {
  const node = resolveSelector(nodes, step.target, screen, step.fallback);
  const screenArea = screen.width * screen.height;
  if (node && tappable(node, overlayFrames(nodes, screen), screen)) {
    const large = node.frame.w * node.frame.h > screenArea * 0.25;
    if (large && step.fallback) return { via: "fallback", point: denormalize(step.fallback, screen), node };
    return { via: "selector", point: center(node.frame), node };
  }
  if (node && !step.fallback) throw new Error(`tap target ${JSON.stringify(step.target)} is off screen or covered`);
  if (step.fallback) return { via: "fallback", point: denormalize(step.fallback, screen) };
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

export async function performTap(driver: DeviceDriver, step: TapStep, nodes: readonly FlatNode[], screen: ScreenInfo): Promise<ExecutedTap> {
  const plan = planTap(step, nodes, screen);
  await driver.tap({ x: Math.round(plan.point.x * 10) / 10, y: Math.round(plan.point.y * 10) / 10 });
  return plan;
}

/** Start and end points of a swipe step: centred on the target (or screen), `distance` of its size. */
export function planSwipe(step: SwipeStep, nodes: readonly FlatNode[], screen: ScreenInfo): { from: Point; to: Point } {
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
  const c = center(area);
  const distance = step.distance ?? 0.5;
  const half = { x: (area.w * distance) / 2, y: (area.h * distance) / 2 };
  switch (step.direction) {
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

export async function performSwipe(driver: DeviceDriver, step: SwipeStep, nodes: readonly FlatNode[], screen: ScreenInfo): Promise<void> {
  const { from, to } = planSwipe(step, nodes, screen);
  await driver.swipe({ from, to, durationMs: 300 });
}

export async function performType(driver: DeviceDriver, step: TypeTextStep): Promise<void> {
  await driver.typeText(step.text, step.target);
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
  const step: SwipeStep = { action: "swipe", direction, distance: Math.round(distance * 100) / 100 };
  return container?.identifier ? { ...step, target: { id: container.identifier } } : step;
}
