/**
 * The driver seam: `runner.ensure` and every `driver.*` call go through a DeviceDriver that a
 * DriverFactory creates for one simulator. Wire the runner-backed driver in `createRunnerDriver`.
 */
import type { DeviceDriver, SimDevice } from "@shotwright/core";
import { createFakeDriver } from "./fake-driver.ts";
import { ensureRunner } from "./runner/index.ts";

export type LogLevel = "info" | "warn" | "error";

/** Prints a line and forwards it to the web UI's log panel. */
export type AgentLogger = (level: LogLevel, message: string) => void;

/** A DeviceDriver the agent owns. `close` releases whatever the driver started. */
export interface AgentDriver extends DeviceDriver {
  close?(): Promise<void>;
}

export interface DriverContext {
  readonly udid: string;
  /** The simulator as `simctl list` reports it, if it was found. */
  readonly device?: SimDevice;
  readonly log: AgentLogger;
}

/**
 * Creates a driver for one simulator. Called by `runner.ensure`: build the runner if needed, start it
 * on the device and resolve once it is healthy. The agent closes the previous driver first, and calls
 * the factory again if the current driver stops answering `screen()`.
 */
export type DriverFactory = (context: DriverContext) => Promise<AgentDriver>;

export type DriverKind = "runner" | "fake";
export const DRIVER_KINDS: readonly DriverKind[] = ["runner", "fake"];

/**
 * The real thing: ShotwrightRunner on the simulator (see ./runner/). `ensureRunner` boots the device,
 * builds the runner once per Xcode version, waits for `/health` and restarts the runner when it hangs.
 */
const createRunnerDriver: DriverFactory = async ({ udid, log }) => {
  const handle = await ensureRunner({ udid, log: (message) => log("info", message) });
  const { driver } = handle;
  return {
    screen: () => driver.screen(),
    launch: (options) => driver.launch(options),
    terminate: (bundleId) => driver.terminate(bundleId),
    home: () => driver.home(),
    source: (bundleId) => driver.source(bundleId),
    screenshot: () => driver.screenshot(),
    tap: (target) => driver.tap(target),
    swipe: (gesture) => driver.swipe(gesture),
    typeText: (text, into) => driver.typeText(text, into),
    close: () => handle.stop(),
  };
};

export function driverFactory(kind: DriverKind): DriverFactory {
  switch (kind) {
    case "runner":
      return createRunnerDriver;
    case "fake":
      return createFakeDriver;
  }
}
