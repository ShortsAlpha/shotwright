/**
 * `duo.state`: is the iPhone Duo simulator unfolded? Nothing reports the fold state, but the inner
 * display (`--display=3`) stays black while the device is folded (docs/spikes/simulator.md,
 * "Update Oct 28"), so one capture of it answers the question.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./exec.ts";
import { litShare } from "./png.ts";

/** Below this share of lit pixels the inner display counts as off (folded). */
const LIT_THRESHOLD = 0.002;

/** Whether a capture of the inner display shows anything. */
export function innerDisplayOn(png: Uint8Array): boolean {
  return litShare(png) > LIT_THRESHOLD;
}

export async function duoState(udid: string): Promise<{ unfolded: boolean }> {
  const dir = await mkdtemp(join(tmpdir(), "shotwright-duo-"));
  try {
    const file = join(dir, "inner.png");
    await run("xcrun", ["simctl", "io", udid, "screenshot", "--type=png", "--display=3", file], { timeoutMs: 30_000 });
    return { unfolded: innerDisplayOn(await readFile(file)) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
