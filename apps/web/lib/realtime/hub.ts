/**
 * In-memory registry of agent connections, pairing codes and sessions. One per process; it lives on
 * globalThis so code bundled by Next (route handlers, server actions) sees the same instance as
 * server.ts.
 */
import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import { PROTOCOL_VERSION, type Hello } from "@shotwright/core";
import { CLOSE_SESSION_NOT_FOUND, type UiServerMessage } from "../ui-protocol.ts";
import { AgentConnection } from "./agent-connection.ts";
import { AttemptLimiter, PAIRING_CODE_LENGTH, PAIRING_TTL_MS, generateCode, normalizeCode } from "./pairing.ts";
import { RemoteDriver } from "./remote-driver.ts";
import { Session } from "./session.ts";

/** Sessions with no agent and no browser for this long are dropped. */
const SESSION_IDLE_MS = 60 * 60_000;

interface PendingPairing {
  readonly code: string;
  readonly expiresAt: number;
  readonly connection: AgentConnection;
  readonly timer: NodeJS.Timeout;
}

export type PairResult =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly status: 400 | 404 | 429; readonly error: string };

export class Hub {
  private readonly sessions = new Map<string, Session>();
  private readonly codes = new Map<string, PendingPairing>();
  private readonly pairingByConnection = new Map<AgentConnection, PendingPairing>();
  private readonly sessionByConnection = new Map<AgentConnection, Session>();
  private readonly limiter = new AttemptLimiter(20, 10 * 60_000);
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** A DeviceDriver that forwards to the session's Mac agent. */
  driver(sessionId: string): RemoteDriver {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return new RemoteDriver(session);
  }

  // --- Agents ---------------------------------------------------------------

  acceptAgent(ws: WebSocket, remoteAddress: string): void {
    new AgentConnection(ws, remoteAddress, {
      hello: (connection, hello) => this.onHello(connection, hello),
      frame: (connection, raw) => this.sessionByConnection.get(connection)?.onAgentFrame(raw),
      log: (connection, log) => this.sessionByConnection.get(connection)?.log("agent", log.level, log.message),
      close: (connection) => this.onAgentClose(connection),
    });
  }

  private onHello(connection: AgentConnection, hello: Hello): void {
    if (hello.protocol !== PROTOCOL_VERSION) {
      connection.close(4426, `Protocol ${hello.protocol} is not supported (server speaks ${PROTOCOL_VERSION}); update the agent`);
      return;
    }
    const resumed = hello.sessionId ? this.sessions.get(hello.sessionId) : undefined;
    if (resumed) {
      this.bind(connection, resumed);
      return;
    }
    this.issueCode(connection);
  }

  private issueCode(connection: AgentConnection): void {
    const code = generateCode((c) => this.codes.has(c));
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    const timer = setTimeout(() => {
      this.dropCode(connection);
      // Still unpaired: hand out a fresh code so the agent stays usable.
      if (!connection.closed && !this.sessionByConnection.has(connection)) this.issueCode(connection);
    }, PAIRING_TTL_MS);
    const pending: PendingPairing = { code, expiresAt, connection, timer };
    this.codes.set(code, pending);
    this.pairingByConnection.set(connection, pending);
    connection.send({ type: "pairing", code, expiresAt: new Date(expiresAt).toISOString() });
  }

  private dropCode(connection: AgentConnection): void {
    const pending = this.pairingByConnection.get(connection);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.codes.delete(pending.code);
    this.pairingByConnection.delete(connection);
  }

  private bind(connection: AgentConnection, session: Session): void {
    this.dropCode(connection);
    if (session.agent) this.sessionByConnection.delete(session.agent);
    this.sessionByConnection.set(connection, session);
    session.attachAgent(connection);
    connection.send({ type: "paired", sessionId: session.id });
  }

  private onAgentClose(connection: AgentConnection): void {
    this.dropCode(connection);
    const session = this.sessionByConnection.get(connection);
    this.sessionByConnection.delete(connection);
    session?.detachAgent(connection);
  }

  /** Pairs the agent showing `input` and creates a session for it. */
  pair(input: string, client: string): PairResult {
    if (this.limiter.blocked(client)) {
      return { ok: false, status: 429, error: "Too many attempts. Wait a few minutes and try again." };
    }
    const code = normalizeCode(input);
    if (code.length !== PAIRING_CODE_LENGTH) {
      return { ok: false, status: 400, error: `The code has ${PAIRING_CODE_LENGTH} characters.` };
    }
    const pending = this.codes.get(code);
    if (!pending || pending.expiresAt < Date.now() || pending.connection.closed) {
      this.limiter.fail(client);
      return { ok: false, status: 404, error: "That code is not valid. Check the agent's terminal for the current code." };
    }
    const session = new Session(randomBytes(18).toString("base64url"));
    this.sessions.set(session.id, session);
    this.bind(pending.connection, session);
    return { ok: true, sessionId: session.id };
  }

  // --- Browsers -------------------------------------------------------------

  acceptUi(ws: WebSocket, sessionId: string | undefined): void {
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) {
      const message: UiServerMessage = {
        type: "error",
        code: "session_not_found",
        message: "This session has ended. Pair your Mac again.",
      };
      ws.send(JSON.stringify(message));
      ws.close(CLOSE_SESSION_NOT_FOUND, "Session not found");
      return;
    }
    session.addUi(ws);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (!session.agent && session.uiSockets.size === 0 && now - session.lastSeen > SESSION_IDLE_MS) {
        session.close();
        this.sessions.delete(id);
      }
    }
    this.limiter.prune();
  }

  close(): void {
    clearInterval(this.sweeper);
    for (const session of this.sessions.values()) session.close(1012, "Server restarting");
    for (const pending of this.codes.values()) {
      clearTimeout(pending.timer);
      pending.connection.close(1012, "Server restarting");
    }
  }
}

const HUB_KEY = Symbol.for("shotwright.hub");

export function getHub(): Hub {
  const store = globalThis as typeof globalThis & { [HUB_KEY]?: Hub };
  return (store[HUB_KEY] ??= new Hub());
}
