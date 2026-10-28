/**
 * DeviceDriver on the server: every call is forwarded to the paired Mac agent's `driver.*` methods.
 * The explorer and the replayer use this; they never talk to the WebSocket directly.
 *
 * `waitForStable` lets the explorer's `stableSource` settle on the Mac in one call instead of
 * polling `source()` over the WebSocket; agents that predate it get the same polling here.
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
import { RpcError } from "./agent-connection.ts";
import type { Session } from "./session.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Same layout: types, identifiers, labels and frames (values change with clocks and progress bars). */
function layoutKey(snapshot: UISnapshot): string {
  const parts: string[] = [];
  const walk = (node: UISnapshot["tree"]) => {
    const f = node.frame;
    parts.push(`${node.type}|${node.identifier ?? ""}|${node.label ?? ""}|${f.x},${f.y},${f.w},${f.h}[`);
    for (const child of node.children ?? []) walk(child);
    parts.push("]");
  };
  walk(snapshot.tree);
  return parts.join("\n");
}

export interface RemoteDriverOptions {
  /** How long a call waits for a disconnected agent to reconnect. Default 20 s. */
  readonly reconnectGraceMs?: number;
}

export class RemoteDriver implements DeviceDriver {
  private readonly session: Session;
  private readonly waitForAgentMs: number;
  /** False once the agent answered `unknown_method` to `driver.waitForStable`. */
  private agentWaits = true;

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

  /** A snapshot once the layout stops changing (or after `timeoutMs`, default 10 s). */
  async waitForStable(options: { bundleId?: string; timeoutMs?: number } = {}): Promise<UISnapshot> {
    const params = {
      ...(options.bundleId !== undefined && { bundleId: options.bundleId }),
      ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    };
    if (this.agentWaits) {
      try {
        return await this.session.call("driver.waitForStable", params, { waitForAgentMs: this.waitForAgentMs });
      } catch (error) {
        if (!(error instanceof RpcError && error.code === "unknown_method")) throw error;
        this.agentWaits = false;
      }
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    const started = Date.now();
    let snapshot = await this.source(options.bundleId);
    let last = layoutKey(snapshot);
    while (Date.now() - started < timeoutMs) {
      await sleep(300);
      snapshot = await this.source(options.bundleId);
      const key = layoutKey(snapshot);
      if (key === last) break;
      last = key;
    }
    return snapshot;
  }

  /** App Store status bar (9:41) on or off. Older agents without it are ignored. */
  async statusBar(override: boolean): Promise<void> {
    try {
      await this.session.call("driver.statusBar", { override }, { waitForAgentMs: this.waitForAgentMs });
    } catch (error) {
      if (!(error instanceof RpcError && error.code === "unknown_method")) throw error;
    }
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
