/**
 * A paired session: one agent connection (replaced on reconnect), any number of browser sockets,
 * a log buffer, the state the UI shows and its explore/replay jobs. Every call to the agent goes
 * through `call`.
 */
import type { WebSocket } from "ws";
import type { AgentMethod, AgentParams, AgentResult, Hello, ScreenInfo, SimDevice } from "@shotwright/core";
import { SessionJobs } from "../jobs/manager.ts";
import { getQuotas } from "../limits.ts";
import {
  BLOCKED_DURING_JOBS,
  UI_METHODS,
  type LogEntry,
  type SessionState,
  type UiMethod,
  type UiResult,
  type UiServerMessage,
} from "../ui-protocol.ts";
import { RpcError, type AgentConnection } from "./agent-connection.ts";
import { RemoteDriver } from "./remote-driver.ts";

const MAX_LOGS = 300;
/** Frames are skipped for a browser that still has this much unsent data. */
const MAX_UI_BUFFER = 1024 * 1024;
/** The live view keeps running this long after the last browser tab closes. */
const STREAM_GRACE_MS = 15_000;
/** Long calls are shown as busy in the UI and logged when they start. */
const TRACKED: ReadonlySet<AgentMethod> = new Set([
  "devices.list", "device.boot", "device.shutdown", "projects.list", "app.build", "app.install", "runner.ensure",
]);

export interface CallOptions {
  readonly timeoutMs?: number;
  /** Wait this long for a disconnected agent to come back before failing. */
  readonly waitForAgentMs?: number;
}

const describe = (method: AgentMethod, params: unknown): string => {
  const p = (params ?? {}) as Record<string, unknown>;
  if (method === "driver.tap" && typeof p.x === "number" && typeof p.y === "number") return `${method} (${p.x}, ${p.y})`;
  if (method === "driver.tap") return `${method} ${JSON.stringify(params)}`;
  if (method === "driver.launch" && typeof p.bundleId === "string") return `${method} ${p.bundleId}`;
  return method;
};

export class Session {
  readonly id: string;
  readonly createdAt = Date.now();
  agent: AgentConnection | null = null;
  private agentHello: Hello | null = null;
  /** When the agent was last connected, for expiring abandoned sessions. */
  lastSeen = Date.now();
  readonly uiSockets = new Set<WebSocket>();
  private logs: LogEntry[] = [];
  private nextLogId = 1;
  private devices: SimDevice[] | null = null;
  private activeUdid: string | null = null;
  private screen: ScreenInfo | null = null;
  private streaming = false;
  /** Live-view settings the user asked for; restarted after a reconnect while someone watches. */
  private wantedStream: AgentParams<"stream.start"> | null = null;
  private lastFrame: string | null = null;
  private readonly busy = new Map<number, { method: AgentMethod; udid?: string }>();
  private nextBusyId = 1;
  private agentWaiters: (() => void)[] = [];
  private streamStopTimer: NodeJS.Timeout | undefined;
  readonly jobs: SessionJobs;

  constructor(id: string) {
    this.id = id;
    const session = this;
    this.jobs = new SessionJobs({
      sessionId: id,
      get agentConnected() {
        return session.agent !== null;
      },
      call: async (method, params) => {
        try {
          return await this.call(method, params, { waitForAgentMs: 20_000 });
        } finally {
          // runner.ensure boots a shut-down simulator.
          if (method === "runner.ensure") void this.refreshDevices();
        }
      },
      driver: () => new RemoteDriver(this),
      device: (udid) => this.devices?.find((d) => d.udid === udid),
      startLiveView: () => this.startLiveView(),
      log: (level, message) => this.log("server", level, message),
      emit: (event) => this.broadcast({ type: "job.event", event }),
      quotaChanged: () => this.pushState(),
    });
  }

  // --- State ----------------------------------------------------------------

  get state(): SessionState {
    const hello = this.agentHello;
    return {
      sessionId: this.id,
      agent: {
        connected: this.agent !== null,
        ...(hello && { agentVersion: hello.agentVersion }),
        ...(hello?.machine.xcode && { xcode: hello.machine.xcode }),
        ...(hello?.machine.macos && { macos: hello.machine.macos }),
      },
      devices: this.devices,
      activeUdid: this.activeUdid,
      screen: this.screen,
      streaming: this.streaming,
      busy: [...this.busy.values()],
      quota: { explore: getQuotas().view("explore", this.id), captions: getQuotas().view("captions", this.id) },
    };
  }

  private broadcast(message: UiServerMessage): void {
    const text = JSON.stringify(message);
    for (const ws of this.uiSockets) if (ws.readyState === ws.OPEN) ws.send(text);
  }

  private pushState(): void {
    this.broadcast({ type: "state", state: this.state });
  }

  log(source: LogEntry["source"], level: LogEntry["level"], message: string): void {
    const entry: LogEntry = { id: this.nextLogId++, ts: Date.now(), source, level, message };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) this.logs = this.logs.slice(-MAX_LOGS);
    this.broadcast({ type: "log", entries: [entry] });
  }

  // --- Agent ----------------------------------------------------------------

  attachAgent(connection: AgentConnection): void {
    const previous = this.agent;
    const resumed = this.agentHello !== null;
    this.agent = connection;
    this.agentHello = connection.hello;
    this.lastSeen = Date.now();
    if (previous && previous !== connection) previous.close(4409, "Replaced by a newer connection");
    const machine = [connection.hello?.machine.xcode && `Xcode ${connection.hello.machine.xcode}`, connection.hello?.machine.macos && `macOS ${connection.hello.machine.macos}`]
      .filter(Boolean)
      .join(", ");
    this.log("server", "info", `Mac agent ${resumed ? "reconnected" : "paired"}${machine ? ` (${machine})` : ""}`);
    for (const resolve of this.agentWaiters.splice(0)) resolve();
    // A reconnected agent has stopped its stream; restart it if someone is watching.
    this.streaming = false;
    this.pushState();
    if (this.wantedStream && this.uiSockets.size > 0) void this.startStream(this.wantedStream);
  }

  detachAgent(connection: AgentConnection): void {
    if (this.agent !== connection) return;
    this.agent = null;
    this.lastSeen = Date.now();
    this.streaming = false;
    this.busy.clear();
    this.log("server", "warn", "Mac agent disconnected; waiting for it to reconnect");
    this.pushState();
  }

  onAgentFrame(raw: string): void {
    this.lastFrame = raw;
    for (const ws of this.uiSockets) {
      if (ws.readyState === ws.OPEN && ws.bufferedAmount < MAX_UI_BUFFER) ws.send(raw);
    }
  }

  private waitForAgent(timeoutMs: number): Promise<AgentConnection | null> {
    if (this.agent) return Promise.resolve(this.agent);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve(this.agent);
      };
      const timer = setTimeout(() => {
        this.agentWaiters = this.agentWaiters.filter((w) => w !== done);
        resolve(null);
      }, timeoutMs);
      this.agentWaiters.push(done);
    });
  }

  /** Calls an agent method and updates the session state from the result. */
  async call<M extends AgentMethod>(method: M, params: AgentParams<M>, options: CallOptions = {}): Promise<AgentResult<M>> {
    const agent = this.agent ?? (options.waitForAgentMs ? await this.waitForAgent(options.waitForAgentMs) : null);
    if (!agent) throw new RpcError("The Mac agent is not connected", "agent_disconnected");

    const udid = typeof (params as { udid?: unknown }).udid === "string" ? (params as { udid: string }).udid : undefined;
    const busyId = this.nextBusyId++;
    const tracked = TRACKED.has(method);
    if (tracked) {
      this.busy.set(busyId, { method, ...(udid && { udid }) });
      this.pushState();
    }
    try {
      const value = await agent.call(method, params, options.timeoutMs);
      this.observe(method, params, value);
      return value;
    } finally {
      if (tracked && this.busy.delete(busyId)) this.pushState();
    }
  }

  private observe<M extends AgentMethod>(method: M, params: AgentParams<M>, value: AgentResult<M>): void {
    switch (method) {
      case "devices.list":
        this.devices = value as SimDevice[];
        break;
      case "runner.ensure":
        this.activeUdid = (params as AgentParams<"runner.ensure">).udid;
        this.screen = value as ScreenInfo;
        break;
      case "driver.screen":
        this.screen = value as ScreenInfo;
        break;
      case "device.shutdown":
        if ((params as AgentParams<"device.shutdown">).udid === this.activeUdid) {
          this.activeUdid = null;
          this.screen = null;
          this.streaming = false;
          this.wantedStream = null;
          this.lastFrame = null;
        }
        break;
      case "stream.start":
        this.streaming = true;
        break;
      case "stream.stop":
        this.streaming = false;
        break;
      default:
        return;
    }
    this.pushState();
  }

  /**
   * Starts the live view (as the browser's Start button does) when someone is watching and it is not
   * running yet. Frames compete with a job's own screenshots on the runner, so not for an empty room.
   */
  async startLiveView(params: AgentParams<"stream.start"> = { fps: 4, maxWidth: 720 }): Promise<void> {
    if (this.streaming || this.uiSockets.size === 0) return;
    this.wantedStream = params;
    await this.call("stream.start", params);
  }

  private async startStream(params: AgentParams<"stream.start">): Promise<void> {
    try {
      await this.call("stream.start", params);
    } catch (error) {
      this.log("server", "warn", `Could not restart the live view: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async refreshDevices(): Promise<void> {
    try {
      await this.call("devices.list", {});
    } catch {
      // The next explicit refresh will show the error.
    }
  }

  // --- Browser --------------------------------------------------------------

  addUi(ws: WebSocket): void {
    this.uiSockets.add(ws);
    clearTimeout(this.streamStopTimer);
    const send = (message: UiServerMessage) => ws.send(JSON.stringify(message));
    send({ type: "state", state: this.state });
    send({ type: "log", entries: this.logs });
    send({ type: "jobs", snapshot: this.jobs.snapshot });
    if (this.lastFrame && this.streaming) ws.send(this.lastFrame);
    if (this.wantedStream && !this.streaming && this.agent && this.activeUdid) void this.startStream(this.wantedStream);

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      void this.onUiMessage(ws, data.toString());
    });
    ws.on("close", () => this.removeUi(ws));
    ws.on("error", () => ws.terminate());
  }

  private removeUi(ws: WebSocket): void {
    this.uiSockets.delete(ws);
    if (this.uiSockets.size > 0 || !this.streaming) return;
    clearTimeout(this.streamStopTimer);
    this.streamStopTimer = setTimeout(() => {
      if (this.uiSockets.size === 0 && this.streaming && this.agent) {
        this.log("server", "info", "No one is watching; pausing the live view");
        this.call("stream.stop", {}).catch(() => undefined);
      }
    }, STREAM_GRACE_MS);
  }

  private async onUiMessage(ws: WebSocket, text: string): Promise<void> {
    let message: { type?: unknown; id?: unknown; method?: unknown; action?: unknown; params?: unknown };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if ((message.type !== "call" && message.type !== "job") || typeof message.id !== "string" || message.id.length > 64) return;
    const reply = (result: Omit<UiResult, "type" | "id">) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "result", id: message.id, ...result }));
    };
    if (message.type === "job") {
      try {
        let value: unknown = null;
        if (message.action === "explore") value = this.jobs.startExplore(message.params);
        else if (message.action === "replay") value = this.jobs.startReplay(message.params);
        else if (message.action === "compose") value = await this.jobs.startCompose(message.params);
        else if (message.action === "caption") value = await this.jobs.editCaption(message.params);
        else if (message.action === "preview") value = await this.jobs.preview(message.params);
        else if (message.action === "cancel") value = this.jobs.cancel();
        else throw new Error(`Unknown job action: ${String(message.action)}`);
        reply({ ok: true, value });
      } catch (error) {
        const code = (error as { code?: unknown }).code === "quota" ? "quota" : "bad_request";
        reply({ ok: false, error: { message: error instanceof Error ? error.message : String(error), code } });
      }
      return;
    }
    if (typeof message.method !== "string" || !(UI_METHODS as readonly string[]).includes(message.method)) {
      reply({ ok: false, error: { message: `Unknown method: ${String(message.method)}`, code: "bad_request" } });
      return;
    }
    const method = message.method as UiMethod;
    const params = (message.params ?? {}) as AgentParams<UiMethod>;
    if (this.jobs.driving && BLOCKED_DURING_JOBS.has(method)) {
      reply({ ok: false, error: { message: "The agent is driving the simulator. Stop the job first.", code: "busy" } });
      return;
    }
    try {
      const value = await this.callFromUi(method, params);
      reply({ ok: true, value });
    } catch (error) {
      reply({
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof RpcError && error.code && { code: error.code }),
        },
      });
    }
  }

  /** A call from the browser: logged, and with side effects the UI relies on. */
  private async callFromUi(method: UiMethod, params: AgentParams<UiMethod>): Promise<unknown> {
    const label = describe(method, params);
    const started = Date.now();
    if (TRACKED.has(method) && method !== "devices.list") this.log("server", "info", `${label}…`);
    if (method === "stream.start") this.wantedStream = params as AgentParams<"stream.start">;
    if (method === "stream.stop") this.wantedStream = null;
    try {
      const value = await this.call(method, params);
      const ms = Date.now() - started;
      if (method !== "devices.list" && method !== "driver.screen") {
        this.log("server", "info", `${label} done${ms >= 1000 ? ` in ${(ms / 1000).toFixed(1)} s` : ""}`);
      }
      return value;
    } catch (error) {
      if (method === "stream.start") this.wantedStream = null;
      this.log("server", "error", `${label} failed: ${error instanceof Error ? error.message : error}`);
      throw error;
    } finally {
      // Booting changes simulator state (runner.ensure boots a shut-down simulator too).
      if (method === "device.boot" || method === "device.shutdown" || method === "runner.ensure") void this.refreshDevices();
    }
  }

  close(code = 4410, reason = "Session ended"): void {
    this.jobs.close();
    this.agent?.close(code, reason);
    for (const ws of this.uiSockets) ws.close(1001, reason);
  }
}
