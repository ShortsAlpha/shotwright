import type { ScreenshotSetId, SimDevice } from "@shotwright/core";
import { CommandError, run } from "./exec.ts";

/** Simulators created for Shotwright, by name, and the screenshot set each one produces. */
export const SHOTWRIGHT_DEVICES: Readonly<Record<string, ScreenshotSetId>> = {
  "Shotwright iPhone 6.3": "iphone-6.3",
  "Shotwright iPad 13": "ipad-13",
  "Shotwright iPhone Duo": "iphone-duo-outer",
};

const SET_ORDER = Object.values(SHOTWRIGHT_DEVICES);

interface RawDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
}

/** "com.apple.CoreSimulator.SimRuntime.iOS-27-0" -> "iOS 27.0" */
export function formatRuntime(id: string): string {
  const match = /SimRuntime\.([A-Za-z]+)-(\d+)-(\d+)/.exec(id);
  return match ? `${match[1]} ${match[2]}.${match[3]}` : id;
}

/** Available iOS simulators: Shotwright's own first, then booted ones, then by name. */
export async function listDevices(): Promise<SimDevice[]> {
  const { stdout } = await run("xcrun", ["simctl", "list", "-j", "devices"], { timeoutMs: 30_000 });
  const json = JSON.parse(stdout) as { devices?: Record<string, RawDevice[]> };
  const devices: SimDevice[] = [];
  for (const [runtimeId, list] of Object.entries(json.devices ?? {})) {
    const runtime = formatRuntime(runtimeId);
    if (!runtime.startsWith("iOS ")) continue;
    for (const device of list) {
      if (device.isAvailable === false) continue;
      const setId = SHOTWRIGHT_DEVICES[device.name];
      devices.push({
        udid: device.udid,
        name: device.name,
        runtime,
        state: device.state,
        ...(setId !== undefined && { setId }),
      });
    }
  }
  const rank = (d: SimDevice) => (d.setId === undefined ? SET_ORDER.length : SET_ORDER.indexOf(d.setId));
  return devices.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      Number(b.state === "Booted") - Number(a.state === "Booted") ||
      a.name.localeCompare(b.name) ||
      b.runtime.localeCompare(a.runtime),
  );
}

const inState = (error: unknown, state: string) =>
  error instanceof CommandError && error.output.includes(`current state: ${state}`);

/** Boots the simulator (headless) and waits until it has finished booting. */
export async function bootDevice(udid: string): Promise<void> {
  try {
    await run("xcrun", ["simctl", "boot", udid], { timeoutMs: 120_000 });
  } catch (error) {
    if (!inState(error, "Booted")) throw error;
  }
  await run("xcrun", ["simctl", "bootstatus", udid], { timeoutMs: 300_000 });
}

export async function shutdownDevice(udid: string): Promise<void> {
  try {
    await run("xcrun", ["simctl", "shutdown", udid], { timeoutMs: 120_000 });
  } catch (error) {
    if (!inState(error, "Shutdown")) throw error;
  }
}

export async function installApp(udid: string, appPath: string): Promise<void> {
  await run("xcrun", ["simctl", "install", udid, appPath], { timeoutMs: 300_000 });
}

/** The App Store status bar: 9:41, full battery, full signal, no carrier name. */
const STATUS_BAR_OVERRIDE = [
  "--time", "9:41",
  "--batteryState", "discharging", "--batteryLevel", "100",
  "--dataNetwork", "5g", "--wifiBars", "3",
  "--cellularMode", "active", "--cellularBars", "4",
  "--operatorName", "",
];

/** Sets (`override`) or clears the status bar override on a booted simulator. */
export async function setStatusBar(udid: string, override: boolean): Promise<void> {
  const args = override ? ["override", ...STATUS_BAR_OVERRIDE] : ["clear"];
  await run("xcrun", ["simctl", "status_bar", udid, ...args], { timeoutMs: 20_000 });
}
