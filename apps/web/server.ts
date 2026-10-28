/**
 * One Node process for the site and its WebSockets:
 *   /agent      Mac agents (packages/core/src/protocol.ts)
 *   /ui         browsers (lib/ui-protocol.ts), authenticated by the session cookie
 *   /api/pair   POST { code } -> { sessionId } and sets the session cookie
 *   /api/artifacts/<runId>/<path>   GET a run file of the cookie's session (lib/jobs/artifacts.ts)
 *   /api/runs/<runId>/zip           GET the run's screenshots as an upload-ready zip (lib/compose/compose.ts)
 * Everything else goes to Next.js, including its dev-mode HMR socket.
 *
 * Model keys (MUSE_API_KEY, BASETEN_API_KEY) come from the environment or the repo's .env.local.
 * SHOTWRIGHT_FAKE_MODELS=1 scripts the model turns and the judge (no keys needed; for the fake agent).
 *
 *   npm run dev                  # tsx server.ts, Next in dev mode, port 3000 (PORT to change)
 *   npm run build && npm start   # production
 */
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import next from "next";
import { WebSocketServer } from "ws";
import { exportZip } from "./lib/compose/compose.ts";
import { closeRenderer } from "./lib/compose/renderer.ts";
import { artifactPath, runDir } from "./lib/jobs/artifacts.ts";
import { getHub } from "./lib/realtime/hub.ts";
import { SESSION_COOKIE } from "./lib/ui-protocol.ts";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env.local", import.meta.url)));
} catch {
  // Keys may come from the environment instead.
}

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

const CONTENT_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", json: "application/json" };

/** GET /api/artifacts/<runId>/<path>: a file from the session's run folder. */
async function handleArtifact(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    json(res, 405, { error: "Use GET" }, { allow: "GET" });
    return;
  }
  const sessionId = readCookie(req, SESSION_COOKIE) ?? url.searchParams.get("session") ?? "";
  if (!getHub().getSession(sessionId)) {
    json(res, 404, { error: "Not found" });
    return;
  }
  let segments: string[];
  try {
    segments = url.pathname.slice("/api/artifacts/".length).split("/").map((s) => decodeURIComponent(s));
  } catch {
    segments = [];
  }
  const [runId = "", ...rest] = segments;
  const file = artifactPath(sessionId, runId, rest.join("/"));
  const info = file ? await stat(file).catch(() => null) : null;
  if (!file || !info?.isFile()) {
    json(res, 404, { error: "Not found" });
    return;
  }
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[file.split(".").pop() ?? ""] ?? "application/octet-stream",
    "content-length": info.size,
    // Versioned URLs (?v=) never change; others may be rewritten by a later replay.
    "cache-control": url.searchParams.has("v") ? "private, max-age=86400, immutable" : "private, no-cache",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

/**
 * GET /api/runs/<runId>/zip: the fastlane deliver layout plus README.txt as `<app>-screenshots.zip`.
 * Screenshots that are stale (a caption changed since the last compose) are rendered first; no
 * model is called here.
 */
async function handleZip(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method !== "GET") {
    json(res, 405, { error: "Use GET" }, { allow: "GET" });
    return;
  }
  const sessionId = readCookie(req, SESSION_COOKIE) ?? "";
  const runId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
  let dir: string;
  try {
    dir = runDir(sessionId, runId);
  } catch {
    json(res, 404, { error: "Not found" });
    return;
  }
  if (!getHub().getSession(sessionId) || !existsSync(dir)) {
    json(res, 404, { error: "Not found" });
    return;
  }
  const aborted = new AbortController();
  res.on("close", () => aborted.abort());
  let zip;
  try {
    zip = await exportZip(dir, { signal: aborted.signal });
  } catch (error) {
    if (aborted.signal.aborted) return;
    json(res, 409, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const session = getHub().getSession(sessionId);
  session?.log("server", "info", `Download: ${zip.name} (${zip.entries} files, ${(zip.bytes / 1e6).toFixed(1)} MB)`);
  if (zip.rendered > 0) void session?.jobs.refreshCompose();
  res.writeHead(200, {
    "content-type": "application/zip",
    "content-length": zip.bytes,
    "content-disposition": `attachment; filename="${zip.name.replace(/[^\w.-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(zip.name)}`,
    "cache-control": "no-store",
  });
  createReadStream(zip.file).pipe(res);
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
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path.startsWith("/api/artifacts/")) {
      handleArtifact(req, res, new URL(req.url ?? "/", "http://localhost")).catch((error: unknown) => {
        console.error(error);
        if (!res.headersSent) json(res, 500, { error: "Internal error" });
      });
      return;
    }
    if (/^\/api\/runs\/[^/]+\/zip$/.test(path)) {
      handleZip(req, res, new URL(req.url ?? "/", "http://localhost")).catch((error: unknown) => {
        console.error(error);
        if (!res.headersSent) json(res, 500, { error: "Internal error" });
      });
      return;
    }
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
    void Promise.allSettled([app.close(), closeRenderer()]).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
