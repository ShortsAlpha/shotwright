/**
 * The device-control surface the explorer and the replayer depend on.
 *
 * Two implementations share it:
 * - on the Mac, the agent talks to ShotwrightRunner over HTTP (ios/ShotwrightRunner/README.md);
 * - on the server, each call is forwarded to a paired Mac agent over WebSocket (protocol.ts).
 *
 * Coordinates are in points, origin top-left (402 x 874 on the iPhone 6.3" simulator);
 * screenshots are native pixels (3x).
 */
import type { ElementSelector } from "./flow.ts";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** One node of the runner's accessibility snapshot (`GET /source`). */
export interface UINode {
  readonly type: string;
  readonly identifier?: string;
  readonly label?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly frame: Rect;
  readonly enabled: boolean;
  readonly selected?: boolean;
  readonly children?: readonly UINode[];
}

export interface UISnapshot {
  readonly bundleId: string;
  /** XCUIApplication state, e.g. "runningForeground". */
  readonly state: string;
  readonly count: number;
  readonly tree: UINode;
}

export interface ScreenInfo {
  /** Screen size in points. */
  readonly width: number;
  readonly height: number;
  readonly currentBundleId?: string;
}

export interface LaunchOptions {
  readonly bundleId: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export type SwipeDirection = "up" | "down" | "left" | "right";

export type TapTarget = Point | ElementSelector;

export type SwipeGesture =
  | { readonly from: Point; readonly to: Point; readonly durationMs?: number }
  | { readonly direction: SwipeDirection; readonly within?: ElementSelector };

export interface DeviceDriver {
  screen(): Promise<ScreenInfo>;
  /** Terminates a running instance, launches, waits until the app is idle. */
  launch(options: LaunchOptions): Promise<void>;
  terminate(bundleId?: string): Promise<void>;
  home(): Promise<void>;
  source(bundleId?: string): Promise<UISnapshot>;
  /** PNG without alpha, native pixels. */
  screenshot(): Promise<Uint8Array>;
  tap(target: TapTarget): Promise<void>;
  swipe(gesture: SwipeGesture): Promise<void>;
  typeText(text: string, into?: ElementSelector): Promise<void>;
}
