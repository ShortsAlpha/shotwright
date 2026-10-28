/** Thin wrappers over `xcrun simctl` used by the runner module. */
import { exec } from "./exec.ts";

export interface SimctlDevice {
  readonly udid: string;
  readonly name: string;
  readonly state: string;
  readonly runtime: string;
}

export async function listDevices(): Promise<SimctlDevice[]> {
  const { stdout } = await exec("xcrun", ["simctl", "list", "devices", "-j"], { timeoutMs: 30_000 });
  const parsed = JSON.parse(stdout) as { devices: Record<string, Array<{ udid: string; name: string; state: string }>> };
  return Object.entries(parsed.devices).flatMap(([runtime, devices]) =>
    devices.map((d) => ({ udid: d.udid, name: d.name, state: d.state, runtime })),
  );
}

export async function deviceState(udid: string): Promise<string | undefined> {
  return (await listDevices()).find((d) => d.udid === udid)?.state;
}

/** Boots the device if needed and waits until it has finished booting. */
export async function bootAndWait(udid: string, timeoutMs = 240_000): Promise<void> {
  await exec("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeoutMs });
}

export async function terminateApp(udid: string, bundleId: string): Promise<void> {
  // Fails when the app is not running; that is fine.
  await exec("xcrun", ["simctl", "terminate", udid, bundleId], { timeoutMs: 15_000 }).catch(() => undefined);
}

/**
 * `simctl launch` fails in under a second when the app is unknown, unlike XCUIApplication.launch(),
 * which can block the runner for minutes right after an install (docs/spikes/simulator.md).
 * Environment variables reach the app through the SIMCTL_CHILD_ prefix.
 */
export async function launchApp(
  udid: string,
  bundleId: string,
  args: readonly string[] = [],
  env: Readonly<Record<string, string>> = {},
): Promise<number | undefined> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) childEnv[`SIMCTL_CHILD_${key}`] = value;
  const { stdout } = await exec(
    "xcrun",
    ["simctl", "launch", "--terminate-running-process", udid, bundleId, ...args],
    { timeoutMs: 60_000, env: childEnv },
  );
  const pid = Number(/:\s*(\d+)\s*$/.exec(stdout.trim())?.[1]);
  return Number.isFinite(pid) ? pid : undefined;
}

export async function installApp(udid: string, appPath: string): Promise<void> {
  await exec("xcrun", ["simctl", "install", udid, appPath], { timeoutMs: 120_000 });
}
