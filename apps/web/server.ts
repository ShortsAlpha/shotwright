/**
 * One Node process for the site and its WebSockets:
 *   /agent      Mac agents (packages/core/src/protocol.ts)
 *   /ui         browsers (lib/ui-protocol.ts), authenticated by the session cookie
 *   /api/pair   POST { code } -> { sessionId } and sets the session cookie
 * Everything else goes to Next.js, including its dev-mode HMR socket.
 *
 *   npm run dev                  # tsx server.ts, Next in dev mode, port 3000 (PORT to change)
 *   npm run build && npm start   # production
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import next from "next";
import { WebSocketServer } from "ws";
import { getHub } from "./lib/realtime/hub.ts";
import { SESSION_COOKIE } from "./lib/ui-protocol.ts";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);
/** Behind a proxy (the container platform), trust X-Forwarded-For for rate limiting. */
const trustProxy = process.env.TRUST_PROXY === "1";

function clientAddress(req: IncomingMessage): string {
  const forwarded = trustProxy ? req.headers["x-forwarded-for"] : undefined;
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 4096): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error("Body too large");
  }
  return body;
}

async function handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "Use POST" }, { allow: "POST" });
    return;
  }
  let code: unknown;
  try {
    code = (JSON.parse(await readBody(req)) as { code?: unknown }).code;
  } catch {
    json(res, 400, { error: "Expected JSON { code }" });
    return;
  }
  if (typeof code !== "string") {
    json(res, 400, { error: "Expected JSON { code }" });
    return;
  }
  const result = getHub().pair(code, clientAddress(req));
  if (!result.ok) {
    json(res, result.status, { error: result.error });
    return;
  }
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  json(res, 200, { sessionId: result.sessionId }, {
    "set-cookie": `${SESSION_COOKIE}=${result.sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`,
  });
}

/** Browsers send Origin on WebSocket handshakes; only accept our own site. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function reject(socket: Duplex, status: number, message: string): void {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

async function main(): Promise<void> {
  const app = next({ dev, port });
  const handle = app.getRequestHandler();
  await app.prepare();

  const hub = getHub();
  const agentSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  const uiSockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/api/pair") {
      handlePair(req, res).catch((error: unknown) => {
        console.error(error);
        if (!res.headersSent) json(res, 500, { error: "Internal error" });
      });
      return;
    }
    void handle(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/agent") {
      agentSockets.handleUpgrade(req, socket, head, (ws) => hub.acceptAgent(ws, clientAddress(req)));
    } else if (url.pathname === "/ui") {
      if (!sameOrigin(req)) {
        reject(socket, 403, "Forbidden");
        return;
      }
      const sessionId = url.searchParams.get("session") ?? readCookie(req, SESSION_COOKIE);
      uiSockets.handleUpgrade(req, socket, head, (ws) => hub.acceptUi(ws, sessionId ?? undefined));
    }
    // Other paths (Next's HMR socket in dev) are handled by the upgrade listener Next adds itself.
  });

  server.listen(port, () => {
    console.log(`> Shotwright ${dev ? "dev" : "production"} server on http://localhost:${port}`);
    console.log(`> Agents connect to ws://localhost:${port}/agent`);
  });

  let closing = false;
  const shutdown = () => {
    if (closing) process.exit(1);
    closing = true;
    hub.close();
    for (const ws of [...agentSockets.clients, ...uiSockets.clients]) ws.terminate();
    server.close();
    void app.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
