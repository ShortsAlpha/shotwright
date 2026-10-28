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
