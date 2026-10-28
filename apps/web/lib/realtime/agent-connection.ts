/** One agent WebSocket: hello handshake, heartbeats and `call`/`result` RPC with timeouts. */
import { randomUUID } from "node:crypto";
import type { RawData, WebSocket } from "ws";
import {
  AgentMessageSchema,
  type AgentMethod,
  type AgentParams,
  type AgentResult,
  type Frame,
  type Hello,
  type Log,
  type ServerMessage,
} from "@shotwright/core";

/** An RPC failure: agent error, timeout or disconnect. */
export class RpcError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

/**
 * Per-call timeouts: backstops above the agent's own worst case, so the server never gives up on a
 * call the Mac is still finishing. Builds and the first runner start are slow. Driver calls are
 * usually quick (a tap right after an app launch took 6.9 s), but the runner driver on the Mac
 * waits up to 20 s for a tap, 30 s for a source and 10 s for a screenshot, then spends up to 15 s
 * deciding whether the runner hung and restarts it (5-30 s) before retrying a read once. A tap also
 * waits for the layout to settle. If the server timed out first, the explorer would fire its next
 * call into a runner that is still restarting.
 */
export const CALL_TIMEOUTS_MS: Readonly<Record<AgentMethod, number>> = {
  "devices.list": 30_000,
  "device.boot": 300_000,
  "device.shutdown": 120_000,
  "projects.list": 180_000,
  "app.build": 20 * 60_000,
  "app.install": 300_000,
  "runner.ensure": 10 * 60_000,
  "stream.start": 15_000,
  "stream.stop": 15_000,
  "driver.screen": 30_000,
  // simctl launch (60 s) plus 1.5 s of layout stability (up to 30 s).
  "driver.launch": 180_000,
  "driver.terminate": 30_000,
  "driver.home": 60_000,
  "driver.source": 120_000,
  "driver.waitForStable": 120_000,
  "driver.screenshot": 90_000,
  "driver.tap": 120_000,
  "driver.swipe": 120_000,
  "driver.typeText": 120_000,
  "driver.statusBar": 30_000,
};

const HELLO_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 20_000;

export interface AgentConnectionEvents {
  hello(connection: AgentConnection, hello: Hello): void;
  frame(connection: AgentConnection, raw: string, frame: Frame): void;
  log(connection: AgentConnection, log: Log): void;
  close(connection: AgentConnection): void;
}

interface Pending {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class AgentConnection {
  readonly id = randomUUID().slice(0, 8);
  readonly remoteAddress: string;
  hello: Hello | null = null;
  closed = false;
  private readonly ws: WebSocket;
  private readonly events: AgentConnectionEvents;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private alive = true;
  private readonly heartbeat: NodeJS.Timeout;
  private readonly helloTimer: NodeJS.Timeout;

  constructor(ws: WebSocket, remoteAddress: string, events: AgentConnectionEvents) {
    this.ws = ws;
    this.remoteAddress = remoteAddress;
    this.events = events;
    ws.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    ws.on("close", () => this.onClose());
    ws.on("error", () => ws.terminate());
    ws.on("pong", () => (this.alive = true));
    this.helloTimer = setTimeout(() => {
      if (!this.hello) this.close(4408, "Expected hello");
    }, HELLO_TIMEOUT_MS);
    this.heartbeat = setInterval(() => {
      if (!this.alive) {
        ws.terminate();
        return;
      }
      this.alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
  }

  send(message: ServerMessage): void {
    if (!this.closed && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(message));
  }

  close(code = 1000, reason = ""): void {
    this.ws.close(code, reason);
  }

  call<M extends AgentMethod>(method: M, params: AgentParams<M>, timeoutMs?: number): Promise<AgentResult<M>> {
    if (this.closed) return Promise.reject(new RpcError("The Mac agent disconnected", "agent_disconnected"));
    const id = `c${this.nextId++}`;
    const limit = timeoutMs ?? CALL_TIMEOUTS_MS[method];
    return new Promise<AgentResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`${method} timed out after ${limit < 1000 ? `${limit} ms` : `${Math.round(limit / 1000)} s`}`, "timeout"));
      }, limit);
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      this.send({ type: "call", id, method, params });
    });
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) return;
    const raw = data.toString();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.close(4400, "Invalid JSON");
      return;
    }
    const parsed = AgentMessageSchema.safeParse(json);
    if (!parsed.success) {
      console.warn(`[agent ${this.id}] ignoring invalid message: ${parsed.error.message.slice(0, 200)}`);
      return;
    }
    const message = parsed.data;
    if (message.type === "hello") {
      if (this.hello) return;
      this.hello = message;
      clearTimeout(this.helloTimer);
      this.events.hello(this, message);
      return;
    }
    if (!this.hello) return;
    switch (message.type) {
      case "result": {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.value ?? null);
        else pending.reject(new RpcError(message.error?.message ?? `${pending.method} failed`, message.error?.code));
        return;
      }
      case "frame":
        // Relay the original text so the server never re-encodes image data.
        this.events.frame(this, raw, message);
        return;
      case "log":
        this.events.log(this, message);
        return;
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.helloTimer);
    clearInterval(this.heartbeat);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RpcError(`The Mac agent disconnected during ${pending.method}`, "agent_disconnected"));
    }
    this.pending.clear();
    this.events.close(this);
  }
}
