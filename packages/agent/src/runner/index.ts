/**
 * The runner module: start ShotwrightRunner on a simulator and drive it.
 *
 *   const { driver, screen, stop } = await ensureRunner({ udid });
 *   await driver.launch({ bundleId, args: ["-seedSampleData"] });
 *   const tree = await driver.source();
 *   ...
 *   await stop();
 *
 * ensureRunner boots the simulator if needed, builds the runner once per Xcode version (and runner
 * source hash), starts `xcodebuild test-without-building` in the background, waits for `/health`,
 * and wires the driver to restart the runner when it hangs. Calls for the same udid and port share
 * one runner.
 */
import type { ScreenInfo } from "@shotwright/core";
import { RunnerDriver, type RunnerDriverOptions } from "./driver.ts";
import { RunnerProcess } from "./process.ts";
import { bootAndWait, deviceState } from "./simctl.ts";

export { RunnerDriver, DEFAULT_TIMEOUTS, findFrame } from "./driver.ts";
export type { RunnerDriverOptions, RunnerSelector, RunnerTimeouts, StableSnapshot } from "./driver.ts";
export { RunnerProcess, DEFAULT_PROJECT_DIR, xcodeVersion } from "./process.ts";
export type { RunnerProcessOptions } from "./process.ts";
export { RunnerError, RunnerRestartedError, RunnerStartError, RunnerTimeoutError } from "./errors.ts";
export { layoutHash } from "./stable.ts";
export type { SettleOptions } from "./stable.ts";
export * as simctl from "./simctl.ts";

export interface EnsureRunnerOptions {
  readonly udid: string;
  /** Build products, logs and result bundles. Default ~/Library/Caches/Shotwright/runner/xcode-<version>-<build>. */
  readonly derivedDataPath?: string;
  /** Default 8615. Use a different port per simulator if several run at once. */
  readonly port?: number;
  /** Boot the simulator when it is shut down. Default true. */
  readonly boot?: boolean;
  /** ios/ShotwrightRunner by default. */
  readonly projectDir?: string;
  readonly forceRebuild?: boolean;
  /** Time allowed for `/health` to answer after starting xcodebuild. Default 300 s (cold boots are slow). */
  readonly healthTimeoutMs?: number;
  /** Driver tuning (timeouts, settling). */
  readonly driver?: Omit<RunnerDriverOptions, "udid" | "port" | "onHang" | "log">;
  readonly log?: (message: string) => void;
}

export interface RunnerHandle {
  readonly driver: RunnerDriver;
  /** Screen size in points (440 x 956 on the iPhone 6.9" simulator). */
  readonly screen: ScreenInfo;
  readonly process: RunnerProcess;
  /** Shuts the runner down (POST /shutdown, then kills xcodebuild if needed). */
  stop(): Promise<void>;
}

const handles = new Map<string, Promise<RunnerHandle>>();

export function ensureRunner(options: EnsureRunnerOptions): Promise<RunnerHandle> {
  const port = options.port ?? 8615;
  const key = `${options.udid}:${port}`;
  const existing = handles.get(key);
  if (existing) {
    return existing.then(async (handle) => {
      if (await handle.process.healthy()) return handle;
      await handle.process.restart();
      return { ...handle, screen: await handle.driver.screen() };
    });
  }
  const created = start(options, port).catch((error: unknown) => {
    handles.delete(key);
    throw error;
  });
  handles.set(key, created);
  return created;
}

async function start(options: EnsureRunnerOptions, port: number): Promise<RunnerHandle> {
  const log = options.log ?? (() => undefined);
  const state = await deviceState(options.udid);
  if (state === undefined) throw new Error(`no simulator with udid ${options.udid}`);
  if (state !== "Booted") {
    if (options.boot === false) throw new Error(`simulator ${options.udid} is ${state}`);
    log(`booting simulator ${options.udid}`);
    await bootAndWait(options.udid);
  }

  const runner = new RunnerProcess({
    udid: options.udid,
    port,
    log,
    ...(options.derivedDataPath ? { derivedDataPath: options.derivedDataPath } : {}),
    ...(options.projectDir ? { projectDir: options.projectDir } : {}),
    ...(options.forceRebuild ? { forceRebuild: true } : {}),
    ...(options.healthTimeoutMs ? { healthTimeoutMs: options.healthTimeoutMs } : {}),
  });
  if (!(await runner.healthy())) await runner.build();
  await runner.start();

  const driver = new RunnerDriver({
    ...options.driver,
    udid: options.udid,
    port,
    log,
    onHang: () => runner.restart(),
  });
  const screen = await driver.screen();
  const key = `${options.udid}:${port}`;
  return {
    driver,
    screen,
    process: runner,
    stop: async () => {
      handles.delete(key);
      await runner.stop();
    },
  };
}
