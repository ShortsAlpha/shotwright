/**
 * Messages between the browser and the server over the `/ui` WebSocket (JSON text frames).
 * The browser pairs with `POST /api/pair`, which sets the session cookie, then opens `/ui`.
 *
 * Browser -> server: `call` (forwarded to the agent; answered with `result`), and `job` (start an
 * exploration or a replay, or cancel; answered with `result`, value the JobView or null).
 * Server -> browser: `state` on connect and on every change, `log` batches, `frame`s from the
 * agent as they arrive (same shape as the agent protocol's `frame`), `jobs` (the whole job
 * snapshot, on connect) followed by `job.event`s (lib/jobs/state.ts), and `error`.
 * Run files (thumbnails, screenshots) are served at `/api/artifacts/<runId>/<path>`.
 */
import type { AgentMethod, Frame, ScreenInfo, SimDevice } from "@shotwright/core";
import type { JobAction, JobEvent, JobsSnapshot } from "./jobs/state.ts";

/** Agent methods the browser may call. */
export const UI_METHODS = [
  "devices.list",
  "device.boot",
  "device.shutdown",
  "projects.list",
  "app.build",
  "app.install",
  "runner.ensure",
  "stream.start",
  "stream.stop",
  "driver.screen",
  "driver.launch",
  "driver.terminate",
  "driver.home",
  "driver.tap",
  "driver.swipe",
  "driver.typeText",
] as const satisfies readonly AgentMethod[];

export type UiMethod = (typeof UI_METHODS)[number];

export const SESSION_COOKIE = "sw_session";

export interface AgentInfo {
  readonly connected: boolean;
  readonly agentVersion?: string;
  readonly xcode?: string;
  readonly macos?: string;
}

export interface SessionState {
  readonly sessionId: string;
  readonly agent: AgentInfo;
  /** Last result of `devices.list`, refreshed after boot and shutdown. */
  readonly devices: readonly SimDevice[] | null;
  /** The simulator the driver is attached to (after `runner.ensure`). */
  readonly activeUdid: string | null;
  /** Its screen size in points, for converting live-view clicks to taps. */
  readonly screen: ScreenInfo | null;
  readonly streaming: boolean;
  /** Methods currently running, with their udid when they have one. */
  readonly busy: readonly { readonly method: AgentMethod; readonly udid?: string }[];
}

export interface LogEntry {
  readonly id: number;
  /** Epoch milliseconds. */
  readonly ts: number;
  readonly source: "agent" | "server";
  readonly level: "info" | "warn" | "error";
  readonly message: string;
}

export interface UiCall {
  readonly type: "call";
  readonly id: string;
  readonly method: UiMethod;
  readonly params: unknown;
}

export interface UiResult {
  readonly type: "result";
  readonly id: string;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly message: string; readonly code?: string };
}

export interface UiJobRequest {
  readonly type: "job";
  readonly id: string;
  readonly action: JobAction;
  /** ExploreParams for "explore", ReplayParams for "replay". */
  readonly params?: unknown;
}

export type UiServerMessage =
  | { readonly type: "state"; readonly state: SessionState }
  | { readonly type: "log"; readonly entries: readonly LogEntry[] }
  | UiResult
  | Frame
  | { readonly type: "jobs"; readonly snapshot: JobsSnapshot }
  | { readonly type: "job.event"; readonly event: JobEvent }
  | { readonly type: "error"; readonly code: "session_not_found" | "bad_request"; readonly message: string };

export type UiClientMessage = UiCall | UiJobRequest;

/** Agent methods the browser may not call while a job drives the simulator. */
export const BLOCKED_DURING_JOBS: ReadonlySet<UiMethod> = new Set([
  "device.boot",
  "device.shutdown",
  "app.build",
  "app.install",
  "runner.ensure",
  "driver.launch",
  "driver.terminate",
  "driver.home",
  "driver.tap",
  "driver.swipe",
  "driver.typeText",
]);

/** Close code for a `/ui` socket whose session does not exist. */
export const CLOSE_SESSION_NOT_FOUND = 4404;
