/**
 * Messages between a Mac agent and the server, sent as JSON text frames over one WebSocket
 * that the agent opens (`/agent`). The agent dials out, so the Mac needs no open ports.
 *
 * 1. Agent connects and sends `hello`.
 * 2. Server answers `pairing` with a short code; the agent prints it. An expired code is
 *    replaced by a new `pairing`. A reconnecting agent sends its `sessionId` in `hello` instead.
 * 3. The user enters the code on the site; the server sends `paired`.
 * 4. The server calls agent methods with `call`; the agent answers each with `result`.
 *    The agent pushes `frame` (live view) and `log` messages on its own.
 */
import * as z from "zod";
import type { LaunchOptions, ScreenInfo, SwipeGesture, TapTarget, UISnapshot } from "./driver.ts";
import type { ElementSelector } from "./flow.ts";
import type { ScreenshotSetId } from "./assets.ts";

export const PROTOCOL_VERSION = 1;

export interface SimDevice {
  readonly udid: string;
  readonly name: string;
  readonly runtime: string;
  readonly state: string;
  /** The screenshot set this simulator produces, for Shotwright's own devices. */
  readonly setId?: ScreenshotSetId;
}

export interface XcodeProject {
  readonly path: string;
  readonly schemes: readonly string[];
}

/** Every method the server can call on an agent, with its params and result. */
export interface AgentMethods {
  "devices.list": { params: Record<string, never>; result: SimDevice[] };
  "device.boot": { params: { udid: string }; result: null };
  "device.shutdown": { params: { udid: string }; result: null };
  "projects.list": { params: { root?: string }; result: XcodeProject[] };
  "app.build": {
    params: { projectPath: string; scheme: string; udid: string; configuration?: "Debug" | "Release" };
    result: { appPath: string; bundleId: string };
  };
  "app.install": { params: { udid: string; appPath: string }; result: null };
  /** Builds the runner if needed, starts it on the device and waits for `/health`. */
  "runner.ensure": { params: { udid: string }; result: ScreenInfo };
  "stream.start": { params: { fps?: number; maxWidth?: number }; result: null };
  "stream.stop": { params: Record<string, never>; result: null };
  "driver.screen": { params: Record<string, never>; result: ScreenInfo };
  "driver.launch": { params: LaunchOptions; result: null };
  "driver.terminate": { params: { bundleId?: string }; result: null };
  "driver.home": { params: Record<string, never>; result: null };
  "driver.source": { params: { bundleId?: string }; result: UISnapshot };
  /**
   * Polls the source on the Mac until the layout stops changing (or `timeoutMs`, default 10 s) and
   * returns the last snapshot. Saves the explorer one round trip per poll.
   */
  "driver.waitForStable": { params: { bundleId?: string; timeoutMs?: number }; result: UISnapshot };
  /** Base64 PNG, no alpha. */
  "driver.screenshot": { params: Record<string, never>; result: { png: string } };
  /** `override: true` sets the App Store status bar (9:41, full battery); false clears it. */
  "driver.statusBar": { params: { override: boolean }; result: null };
  "driver.tap": { params: TapTarget; result: null };
  "driver.swipe": { params: SwipeGesture; result: null };
  "driver.typeText": { params: { text: string; into?: ElementSelector }; result: null };
  /**
   * The app icon for theming: the largest PNG in an `AppIcon*.appiconset` under the project's
   * folder (DerivedData, .build and node_modules are skipped); light-mode variants beat dark and
   * tinted ones. `projectPath` is the .xcodeproj/.xcworkspace (its folder is searched) or a folder.
   * Null when the project has no PNG app icon.
   */
  "app.icon": { params: { projectPath: string }; result: AppIcon | null };
  /**
   * iPhone Duo fold state: the inner display (`simctl io --display=3`) is black while folded.
   * The developer unfolds it once per boot in Device Hub.
   */
  "duo.state": { params: { udid: string }; result: { unfolded: boolean } };
}

export interface AppIcon {
  /** Base64 PNG. */
  readonly png: string;
  readonly width: number;
  readonly height: number;
  /** Where it was found on the Mac, relative to the searched folder. */
  readonly file: string;
}

export type AgentMethod = keyof AgentMethods;
export type AgentParams<M extends AgentMethod> = AgentMethods[M]["params"];
export type AgentResult<M extends AgentMethod> = AgentMethods[M]["result"];

// --- Agent -> server ---------------------------------------------------------

export const HelloSchema = z.object({
  type: z.literal("hello"),
  protocol: z.number().int(),
  agentVersion: z.string(),
  machine: z.object({ xcode: z.string().optional(), macos: z.string().optional() }),
  /**
   * The session from an earlier `paired`, sent again after a reconnect. If the server still
   * knows it, it answers `paired` right away; otherwise it issues a new `pairing` code.
   */
  sessionId: z.string().optional(),
});

export const ResultSchema = z.object({
  type: z.literal("result"),
  id: z.string(),
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: z.object({ message: z.string(), code: z.string().optional() }).optional(),
});

export const FrameSchema = z.object({
  type: z.literal("frame"),
  seq: z.number().int(),
  mime: z.enum(["image/jpeg", "image/png"]),
  /** Base64 image data. */
  data: z.string(),
  width: z.number().int(),
  height: z.number().int(),
});

export const LogSchema = z.object({
  type: z.literal("log"),
  level: z.enum(["info", "warn", "error"]),
  message: z.string(),
});

export const AgentMessageSchema = z.discriminatedUnion("type", [HelloSchema, ResultSchema, FrameSchema, LogSchema]);

// --- Server -> agent ---------------------------------------------------------

export const PairingSchema = z.object({
  type: z.literal("pairing"),
  code: z.string(),
  expiresAt: z.string(),
});

export const PairedSchema = z.object({
  type: z.literal("paired"),
  sessionId: z.string(),
});

export const CallSchema = z.object({
  type: z.literal("call"),
  id: z.string(),
  method: z.string(),
  params: z.unknown(),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [PairingSchema, PairedSchema, CallSchema]);

export type Hello = z.infer<typeof HelloSchema>;
export type Result = z.infer<typeof ResultSchema>;
export type Frame = z.infer<typeof FrameSchema>;
export type Log = z.infer<typeof LogSchema>;
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
export type Pairing = z.infer<typeof PairingSchema>;
export type Paired = z.infer<typeof PairedSchema>;
export type Call = z.infer<typeof CallSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
