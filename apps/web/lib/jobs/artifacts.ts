/**
 * Where job results live on the server, one folder per session and run:
 *
 *   <data>/sessions/<sessionId>/
 *     latest.json                      { runId, dir } of the newest run
 *     runs/<runId>/
 *       manifest.json                  what the renderer reads (see Manifest below)
 *       job.json                       request, project, device, status, timestamps
 *       exploration.json, flow.json    from explore() (flow, screen records, steps, usage, graph)
 *       judge.json                     screen judge: ranking and captions
 *       screens/<name>.png             marked screens, full resolution, exploration locale
 *       steps/NNN.jpg, NNN.txt         what the model saw at each step
 *       thumbs/<name>.jpg              360 px wide, for the page
 *       replay/<locale>/<name>.png     replayed screens, full resolution
 *       replay/<locale>/thumbs/<name>.jpg
 *       replay/replay.json             per-locale results (steps, checks, files)
 *
 * <data> is `.shotwright` at the repo root, or SHOTWRIGHT_DATA_DIR.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { downscale } from "@shotwright/explorer";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export const DATA_DIR = resolve(process.env.SHOTWRIGHT_DATA_DIR ?? join(REPO_ROOT, ".shotwright"));

export const THUMB_WIDTH = 360;

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,120}$/;

export function sessionDir(sessionId: string): string {
  if (!SAFE_ID.test(sessionId)) throw new Error("Bad session id");
  return join(DATA_DIR, "sessions", sessionId);
}

export function runDir(sessionId: string, runId: string): string {
  if (!SAFE_ID.test(runId)) throw new Error("Bad run id");
  return join(sessionDir(sessionId), "runs", runId);
}

/** "20261028-153012-a1b2": sortable, unique enough per session. */
export function newRunId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/** The file for `/api/artifacts/<runId>/<path>`, or null when the path is not a plain run file. */
export function artifactPath(sessionId: string, runId: string, path: string): string | null {
  if (!SAFE_ID.test(sessionId) || !SAFE_ID.test(runId)) return null;
  const segments = path.split("/");
  if (segments.length === 0 || segments.length > 4 || !segments.every((s) => SAFE_SEGMENT.test(s))) return null;
  if (!/\.(png|jpg|json)$/.test(path)) return null;
  return join(runDir(sessionId, runId), ...segments);
}

/** Writes JSON atomically, so a reader never sees half a file. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, file);
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** A JPEG thumbnail of a PNG screenshot, THUMB_WIDTH wide. */
export async function writeThumb(png: Uint8Array, file: string): Promise<void> {
  const { width, height } = pngSize(png);
  const w = Math.min(THUMB_WIDTH, width);
  const jpeg = await downscale(png, w, Math.round((height * w) / width), 78);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, jpeg);
}

/** What a renderer needs from a run, with paths relative to the run folder. */
export interface Manifest {
  readonly version: 1;
  readonly runId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly app: {
    readonly name: string;
    readonly bundleId: string;
    readonly projectPath: string;
    readonly scheme: string;
    /** Launch arguments as typed, `{language}` and `{region}` unexpanded. */
    readonly launchArgs: string;
    readonly description: string;
  };
  readonly device: {
    readonly udid: string;
    readonly name?: string;
    /** "iphone-6.3" etc. for Shotwright's own simulators (SCREENSHOT_SETS in @shotwright/core). */
    readonly setId?: string;
    /** Points; screenshots are native pixels. */
    readonly screen: { readonly width: number; readonly height: number };
  };
  readonly explorationLocale: string;
  readonly explorer: { readonly model: string; readonly costUsd: number; readonly stoppedBecause: string };
  /** "judge" when the screen judge ranked and captioned the screens, else the explorer's order. */
  readonly rankedBy: "judge" | "explorer";
  /** Best first. `locales[code]` exists once that locale has been replayed. */
  readonly screens: ReadonlyArray<{
    readonly name: string;
    readonly rank: number;
    /** Judge's score (1-10), else the explorer's. */
    readonly score: number;
    /** English caption from the judge; empty without one. */
    readonly caption: string;
    /** The explorer's reason for marking it. */
    readonly why: string;
    readonly file: string;
    readonly locales: Readonly<Record<string, { readonly file: string; readonly verified: boolean }>>;
  }>;
  readonly files: {
    readonly exploration: string;
    readonly flow: string;
    readonly judge?: string;
    readonly replay?: string;
  };
}
