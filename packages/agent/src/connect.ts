/**
 * `shotwright-agent connect`: dials the server's /agent WebSocket, prints the pairing code and
 * answers calls until interrupted. Reconnects with backoff and resumes the paired session.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  PROTOCOL_VERSION,
  ServerMessageSchema,
  type AgentMessage,
  type Call,
  type Hello,
  type Pairing,
} from "@shotwright/core";
import { driverFactory, type DriverKind, type LogLevel } from "./drivers.ts";
import { Handlers } from "./handlers.ts";
import { AgentError } from "./params.ts";

const exec = promisify(execFile);

export interface ConnectOptions {
  readonly server: string;
  readonly driver: DriverKind;
  readonly projectsRoot: string;
  readonly agentVersion: string;
}

/** Close codes the server uses for errors that reconnecting cannot fix. */
const FATAL_CLOSE_CODES = new Set([4426]);
const MAX_BUFFERED_BYTES = 256 * 1024;
const tty = process.stdout.isTTY;
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[22m` : s);
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[22m` : s);
const time = () => new Date().toTimeString().slice(0, 8);

async function machineInfo(): Promise<Hello["machine"]> {
  const [xcode, macos] = await Promise.all([
    exec("xcodebuild", ["-version"], { timeout: 20_000 })
      .then(({ stdout }) => stdout.split("\n")[0]?.replace(/^Xcode\s+/, "").trim())
      .catch(() => undefined),
    exec("sw_vers", ["-productVersion"], { timeout: 5_000 })
      .then(({ stdout }) => stdout.trim())
      .catch(() => undefined),
  ]);
  return { ...(xcode && { xcode }), ...(macos && { macos }) };
}

/** The site's address for a server URL: ws://host/agent -> http://host */
function siteUrl(server: string): string {
  const url = new URL(server);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/";
  return url.origin;
}

function printPairing(pairing: Pairing, server: string): void {
  const code = `${pairing.code.slice(0, 3)} ${pairing.code.slice(3)}`;
  const minutes = Math.max(1, Math.round((Date.parse(pairing.expiresAt) - Date.now()) / 60_000));
  const inner = `   Pairing code:  ${bold(code)}   `;
  const width = `   Pairing code:  ${code}   `.length;
  console.log(`\n  ┌${"─".repeat(width)}┐\n  │${inner}│\n  └${"─".repeat(width)}┘`);
  console.log(`  Enter it at ${bold(siteUrl(server))} (expires in ${minutes} min)\n`);
}

export function connect(options: ConnectOptions): Promise<number> {
  return new Promise((resolveExit) => {
    let socket: WebSocket | null = null;
    let sessionId: string | undefined;
    let attempt = 0;
    let stopping = false;
    let reconnectTimer: NodeJS.Timeout | undefined;
    let machine: Hello["machine"] = {};

    const isOpen = () => socket !== null && socket.readyState === WebSocket.OPEN;
    const send = (message: AgentMessage) => {
      if (isOpen()) socket!.send(JSON.stringify(message));
    };
    const log = (level: LogLevel, message: string) => {
      const line = `${dim(time())} ${message}`;
      if (level === "info") console.log(line);
      else console.error(`${line}${level === "warn" ? " (warning)" : " (error)"}`);
      send({ type: "log", level, message });
    };

    const handlers = new Handlers({
      factory: driverFactory(options.driver),
      log,
      projectsRoot: options.projectsRoot,
      sink: {
        ready: () => isOpen() && socket!.bufferedAmount < MAX_BUFFERED_BYTES,
        send: (frame) => send(frame),
      },
    });

    async function handleCall(call: Call): Promise<void> {
      const started = Date.now();
      try {
        if (!handlers.has(call.method)) throw new AgentError(`Unknown method: ${call.method}`, "unknown_method");
        const value = await handlers.dispatch(call.method, call.params);
        send({ type: "result", id: call.id, ok: true, value: value ?? null });
        if (call.method !== "driver.screenshot" && call.method !== "driver.screen") {
          console.log(`${dim(time())} ${call.method} ${dim(`ok, ${Date.now() - started} ms`)}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof AgentError ? error.code : undefined;
        send({ type: "result", id: call.id, ok: false, error: { message, ...(code && { code }) } });
        console.error(`${dim(time())} ${call.method} failed: ${message}`);
      }
    }

    function onMessage(data: unknown): void {
      if (typeof data !== "string") return;
      let parsed;
      try {
        parsed = ServerMessageSchema.safeParse(JSON.parse(data));
      } catch {
        return;
      }
      if (!parsed.success) {
        console.error(`${dim(time())} Ignoring an unexpected message from the server`);
        return;
      }
      const message = parsed.data;
      switch (message.type) {
        case "pairing":
          attempt = 0;
          sessionId = undefined;
          printPairing(message, options.server);
          break;
        case "paired":
          attempt = 0;
          if (message.sessionId !== sessionId) {
            console.log(`${dim(time())} ${bold("Paired.")} Keep this running; control the simulator from the site.`);
          } else {
            console.log(`${dim(time())} Reconnected to the session.`);
          }
          sessionId = message.sessionId;
          break;
        case "call":
          void handleCall(message);
          break;
      }
    }

    function open(): void {
      reconnectTimer = undefined;
      const ws = new WebSocket(options.server);
      socket = ws;
      ws.onopen = () => {
        const hello: Hello = {
          type: "hello",
          protocol: PROTOCOL_VERSION,
          agentVersion: options.agentVersion,
          machine,
          ...(sessionId && { sessionId }),
        };
        ws.send(JSON.stringify(hello));
      };
      ws.onmessage = (event) => onMessage(event.data);
      ws.onerror = () => {
        // A close event always follows; reconnecting is handled there.
      };
      ws.onclose = (event) => {
        if (socket === ws) socket = null;
        handlers.streamer.stop();
        if (stopping) return;
        if (FATAL_CLOSE_CODES.has(event.code)) {
          console.error(`The server closed the connection: ${event.reason || event.code}`);
          void shutdown(1);
          return;
        }
        const delay = Math.min(30_000, 1000 * 2 ** attempt) * (0.8 + Math.random() * 0.4);
        attempt++;
        const why = event.reason ? ` (${event.reason})` : "";
        console.error(
          `${dim(time())} ${attempt === 1 ? "Disconnected" : "Could not connect"}${why}; retrying in ${Math.round(delay / 1000)} s`,
        );
        reconnectTimer = setTimeout(open, delay);
      };
    }

    async function shutdown(code: number): Promise<void> {
      if (stopping) return;
      stopping = true;
      clearTimeout(reconnectTimer);
      socket?.close(1000, "Agent stopped");
      await handlers.close();
      resolveExit(code);
    }

    process.once("SIGINT", () => void shutdown(0));
    process.once("SIGTERM", () => void shutdown(0));

    console.log(`shotwright-agent ${options.agentVersion} (driver: ${options.driver})`);
    console.log(`Connecting to ${options.server}`);
    void machineInfo().then((info) => {
      machine = info;
      open();
    });
  });
}
