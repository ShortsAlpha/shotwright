/**
 * DeviceDriver on the server: every call is forwarded to the paired Mac agent's `driver.*` methods.
 * The explorer and the replayer use this; they never talk to the WebSocket directly.
 */
import type {
  DeviceDriver,
  ElementSelector,
  LaunchOptions,
  ScreenInfo,
  SwipeGesture,
  TapTarget,
  UISnapshot,
} from "@shotwright/core";
import type { Session } from "./session.ts";

export interface RemoteDriverOptions {
  /** How long a call waits for a disconnected agent to reconnect. Default 20 s. */
  readonly reconnectGraceMs?: number;
}

export class RemoteDriver implements DeviceDriver {
  private readonly session: Session;
  private readonly waitForAgentMs: number;

  constructor(session: Session, options: RemoteDriverOptions = {}) {
    this.session = session;
    this.waitForAgentMs = options.reconnectGraceMs ?? 20_000;
  }

  /** Builds and starts the runner on `udid` if needed; later calls go to that simulator. */
  ensure(udid: string): Promise<ScreenInfo> {
    return this.session.call("runner.ensure", { udid }, { waitForAgentMs: this.waitForAgentMs });
  }

  screen(): Promise<ScreenInfo> {
    return this.session.call("driver.screen", {}, { waitForAgentMs: this.waitForAgentMs });
  }

  async launch(options: LaunchOptions): Promise<void> {
    await this.session.call("driver.launch", options, { waitForAgentMs: this.waitForAgentMs });
  }

  async terminate(bundleId?: string): Promise<void> {
    await this.session.call("driver.terminate", bundleId === undefined ? {} : { bundleId }, { waitForAgentMs: this.waitForAgentMs });
  }

  async home(): Promise<void> {
    await this.session.call("driver.home", {}, { waitForAgentMs: this.waitForAgentMs });
  }

  source(bundleId?: string): Promise<UISnapshot> {
    return this.session.call("driver.source", bundleId === undefined ? {} : { bundleId }, { waitForAgentMs: this.waitForAgentMs });
  }

  async screenshot(): Promise<Uint8Array> {
    const { png } = await this.session.call("driver.screenshot", {}, { waitForAgentMs: this.waitForAgentMs });
    return new Uint8Array(Buffer.from(png, "base64"));
  }

  async tap(target: TapTarget): Promise<void> {
    await this.session.call("driver.tap", target, { waitForAgentMs: this.waitForAgentMs });
  }

  async swipe(gesture: SwipeGesture): Promise<void> {
    await this.session.call("driver.swipe", gesture, { waitForAgentMs: this.waitForAgentMs });
  }

  async typeText(text: string, into?: ElementSelector): Promise<void> {
    await this.session.call("driver.typeText", into === undefined ? { text } : { text, into }, { waitForAgentMs: this.waitForAgentMs });
  }
}
