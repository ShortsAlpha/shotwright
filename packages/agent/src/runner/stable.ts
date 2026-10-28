/**
 * Readiness: a snapshot is "stable" when two consecutive `/source` snapshots have the same
 * structure (type, identifier, label, frame). Values are left out because clocks and progress
 * indicators change them without the layout changing (docs/spikes/simulator.md, spike 1).
 */
import { createHash } from "node:crypto";
import type { UINode } from "@shotwright/core";

/** Canonical string of the layout; field order is fixed, so the runner's random JSON key order does not matter. */
function canonical(node: UINode, out: string[]): void {
  const f = node.frame;
  out.push(`${node.type}|${node.identifier ?? ""}|${node.label ?? ""}|${f.x},${f.y},${f.w},${f.h}`);
  if (node.children && node.children.length > 0) {
    out.push("[");
    for (const child of node.children) canonical(child, out);
    out.push("]");
  }
}

export function layoutHash(tree: UINode): string {
  const parts: string[] = [];
  canonical(tree, parts);
  return createHash("sha1").update(parts.join("\n")).digest("hex");
}

export interface SettleOptions {
  /** Delay between `/source` polls. Default 300 ms. */
  readonly intervalMs?: number;
  /** Give up after this long and return the last snapshot (marked unstable). Default 10 s. */
  readonly timeoutMs?: number;
  /**
   * The layout must stay unchanged for at least this long. 0 = two consecutive equal snapshots.
   * Use about 1500 ms after a launch so a short-lived splash screen is not taken as ready.
   */
  readonly minStableMs?: number;
}

/** A grayscale thumbnail of the screen from the runner's `GET /frame` (row-major, one byte per pixel). */
export interface Frame {
  readonly w: number;
  readonly h: number;
  readonly gray: Uint8Array;
  /** XCUIApplication state of the requested bundle id, e.g. "foreground". */
  readonly state?: string;
}

/**
 * Share of the content area (below the status bar, above the home indicator) that differs
 * clearly from its median grey. A blank launch screen (white or black, 4-10 s on this Mac) is
 * close to 0; any real screen with text or icons is well above 0.004.
 */
export function contentShare(frame: Frame): number {
  const { w, h, gray } = frame;
  const top = Math.floor(h * 0.08);
  const bottom = Math.ceil(h * 0.95);
  const histogram = new Array<number>(256).fill(0);
  for (let y = top; y < bottom; y++) for (let x = 0; x < w; x++) histogram[gray[y * w + x]!]!++;
  const total = (bottom - top) * w;
  let seen = 0;
  let median = 0;
  for (; median < 256; median++) {
    seen += histogram[median]!;
    if (seen * 2 >= total) break;
  }
  let off = 0;
  for (let v = 0; v < 256; v++) if (Math.abs(v - median) > 14) off += histogram[v]!;
  return total > 0 ? off / total : 0;
}

/** Mean absolute difference (0-255) and the share of pixels that changed by more than 12 levels. */
export function frameDiff(a: Frame, b: Frame): { mean: number; changed: number } {
  if (a.w !== b.w || a.h !== b.h) return { mean: 255, changed: 1 };
  let sum = 0;
  let changed = 0;
  for (let i = 0; i < a.gray.length; i++) {
    const d = Math.abs(a.gray[i]! - b.gray[i]!);
    sum += d;
    if (d > 12) changed++;
  }
  return { mean: sum / a.gray.length, changed: changed / a.gray.length };
}

/** Two frames show the same picture (allowing for a blinking caret or a tiny spinner). */
export function sameFrame(a: Frame, b: Frame): boolean {
  const d = frameDiff(a, b);
  return d.mean < 0.6 && d.changed < 0.002;
}
