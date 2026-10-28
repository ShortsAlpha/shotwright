/**
 * Capture settling: the screenshot for a marked screen (exploration) or a screenshot step (replay)
 * is taken only when
 * 1. the accessibility tree is stable (two equal layouts), and
 * 2. two consecutive screenshots are near-identical (96 px wide grey thumbnails: mean absolute
 *    difference <= 0.6 levels and at most 0.2 % of pixels changed by more than 12 levels),
 * with a cap (4 s by default). A stable tree alone misses purely visual motion: a large title
 * collapsing, a cross-fade, a scroll-edge blur catching up, a chart animating in. When the cap is
 * hit, the last frame is used and a log line says so.
 *
 * Works with any DeviceDriver (it only needs `source` and `screenshot`), so the server-side
 * explorer gets the same behaviour over the WebSocket driver.
 */
import type { DeviceDriver, UISnapshot } from "@shotwright/core";
import sharp from "sharp";
import { layoutKey, stableSource } from "./observe.ts";

export interface CaptureSettleOptions {
  /** Stop waiting after this long and use the last frame (logged). Default 4000 ms. */
  readonly timeoutMs?: number;
  /** Pause between screenshots. Default 120 ms (a screenshot itself takes 110-200 ms). */
  readonly intervalMs?: number;
  /** Largest mean absolute grey difference (0-255) between the two thumbnails. Default 0.6. */
  readonly maxMeanDiff?: number;
  /** Largest share of thumbnail pixels that changed by more than 12 grey levels. Default 0.002. */
  readonly maxChangedShare?: number;
}

export interface SettledCapture {
  /** The PNG to save: the second of the two matching screenshots (or the last one at the cap). */
  readonly png: Uint8Array;
  readonly snapshot: UISnapshot;
  /** Both conditions held before the cap. */
  readonly settled: boolean;
  /** Screenshots taken. */
  readonly frames: number;
  readonly waitedMs: number;
  /** The last comparison. */
  readonly diff: { readonly mean: number; readonly changed: number };
}

export interface CaptureContext {
  readonly bundleId: string;
  readonly log?: (message: string) => void;
  readonly signal?: AbortSignal;
  /** Prefix for the log line, e.g. the screen name. */
  readonly label?: string;
}

const THUMB_WIDTH = 96;

async function thumbnail(png: Uint8Array): Promise<{ data: Uint8Array; w: number; h: number }> {
  const meta = await sharp(png).metadata();
  const w = THUMB_WIDTH;
  const h = meta.width && meta.height ? Math.max(1, Math.round((meta.height * w) / meta.width)) : 208;
  const out = await sharp(png).greyscale().resize(w, h, { fit: "fill" }).raw().toBuffer();
  return { data: new Uint8Array(out.buffer, out.byteOffset, out.byteLength), w, h };
}

/** Mean absolute grey difference and the share of pixels that changed by more than 12 levels. */
export async function compareScreenshots(a: Uint8Array, b: Uint8Array): Promise<{ mean: number; changed: number }> {
  const [ta, tb] = await Promise.all([thumbnail(a), thumbnail(b)]);
  return compareThumbs(ta, tb);
}

function compareThumbs(a: { data: Uint8Array; w: number; h: number }, b: { data: Uint8Array; w: number; h: number }): { mean: number; changed: number } {
  if (a.w !== b.w || a.h !== b.h) return { mean: 255, changed: 1 };
  let sum = 0;
  let changed = 0;
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i]! - b.data[i]!);
    sum += d;
    if (d > 12) changed++;
  }
  return { mean: Math.round((sum / a.data.length) * 100) / 100, changed: Math.round((changed / a.data.length) * 10_000) / 10_000 };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error("Aborted"), { name: "AbortError" });
}

/** Waits for a stable tree and two near-identical screenshots (see the module comment). */
export async function settleCapture(driver: DeviceDriver, context: CaptureContext, options: CaptureSettleOptions = {}): Promise<SettledCapture> {
  const timeoutMs = options.timeoutMs ?? 4_000;
  const intervalMs = options.intervalMs ?? 120;
  const maxMean = options.maxMeanDiff ?? 0.6;
  const maxChanged = options.maxChangedShare ?? 0.002;
  const started = Date.now();
  const deadline = started + timeoutMs;
  throwIfAborted(context.signal);
  let snapshot = await stableSource(driver, context.bundleId);
  let png = await driver.screenshot();
  let thumb = await thumbnail(png);
  let frames = 1;
  let moved = false;
  let diff = { mean: 255, changed: 1 };
  for (;;) {
    throwIfAborted(context.signal);
    await new Promise((r) => setTimeout(r, intervalMs));
    const next = await driver.screenshot();
    const nextThumb = await thumbnail(next);
    frames++;
    diff = compareThumbs(thumb, nextThumb);
    png = next;
    thumb = nextThumb;
    if (diff.mean <= maxMean && diff.changed <= maxChanged) {
      if (!moved) break;
      // The picture was moving: make sure the layout settled too (bypassing the driver's cache).
      const fresh = await stableSource(driver, context.bundleId, Math.max(1_000, deadline - Date.now()), true);
      if (layoutKey(fresh.tree) === layoutKey(snapshot.tree)) {
        snapshot = fresh;
        break;
      }
      snapshot = fresh;
    } else {
      moved = true;
    }
    if (Date.now() > deadline) {
      context.log?.(
        `capture${context.label ? ` ${context.label}` : ""}: the picture did not settle within ${timeoutMs} ms ` +
          `(last change: mean ${diff.mean}, ${(diff.changed * 100).toFixed(2)} % of pixels); using the last frame`,
      );
      return { png, snapshot, settled: false, frames, waitedMs: Date.now() - started, diff };
    }
  }
  return { png, snapshot, settled: true, frames, waitedMs: Date.now() - started, diff };
}
