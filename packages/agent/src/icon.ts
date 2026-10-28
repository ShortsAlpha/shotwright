/**
 * `app.icon`: the app icon from the project's asset catalog, for theming the screenshots.
 *
 * Searches the project's folder for `AppIcon*.appiconset` directories (breadth first, skipping build
 * output and dependencies) and returns the largest PNG of the best one. Light-mode images beat the
 * dark and tinted variants Xcode 16 added (from Contents.json `appearances`, or the file name).
 * Read-only: nothing in the project is touched.
 */
import { open, readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import type { AppIcon } from "@shotwright/core";
import { pngSize } from "./png.ts";

const SKIP_DIRS = new Set(["DerivedData", ".build", "node_modules", "Pods", "Carthage", "build", ".git", ".swiftpm"]);
const MAX_DEPTH = 8;
const MAX_DIRS = 20_000;
/** An icon bigger than this is not an app icon. */
const MAX_BYTES = 8 * 1024 * 1024;

interface Candidate {
  readonly file: string;
  readonly set: string;
  readonly width: number;
  readonly height: number;
  /** 0 for light (default) images, 1 for dark or tinted ones. */
  readonly variant: number;
  readonly exactName: boolean;
  readonly depth: number;
}

/** The folder to search: the project's own folder for an .xcodeproj/.xcworkspace, else the path itself. */
export function searchRoot(projectPath: string): string {
  const ext = extname(projectPath);
  return ext === ".xcodeproj" || ext === ".xcworkspace" ? dirname(projectPath) : projectPath;
}

/** `AppIcon*.appiconset` folders under `root`, breadth first. */
async function findIconSets(root: string): Promise<Array<{ path: string; depth: number }>> {
  const found: Array<{ path: string; depth: number }> = [];
  let queue = [root];
  let visited = 0;
  for (let depth = 0; depth <= MAX_DEPTH && queue.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      if (++visited > MAX_DIRS) return found;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.name.endsWith(".appiconset")) {
          if (/^AppIcon/i.test(entry.name)) found.push({ path, depth });
        } else if (!entry.name.startsWith(".") && !/\.(app|framework|xcframework|xcarchive|xcresult|bundle|lproj)$/.test(entry.name)) {
          next.push(path);
        }
      }
    }
    queue = next;
  }
  return found;
}

/** File names Contents.json marks with a dark or tinted appearance. */
async function variantFiles(set: string): Promise<Set<string>> {
  try {
    const contents = JSON.parse(await readFile(join(set, "Contents.json"), "utf8")) as {
      images?: Array<{ filename?: string; appearances?: unknown[] }>;
    };
    return new Set((contents.images ?? []).filter((i) => i.filename && i.appearances?.length).map((i) => i.filename!));
  } catch {
    return new Set();
  }
}

async function candidates(set: string, depth: number): Promise<Candidate[]> {
  const variants = await variantFiles(set);
  const out: Candidate[] = [];
  for (const name of await readdir(set).catch(() => [] as string[])) {
    if (!/\.png$/i.test(name)) continue;
    const file = join(set, name);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_BYTES) continue;
      // The size is in the first 24 bytes; read the whole (small) file only for the winner.
      const head = Buffer.alloc(24);
      const handle = await open(file, "r");
      try {
        await handle.read(head, 0, 24, 0);
      } finally {
        await handle.close();
      }
      const { width, height } = pngSize(head);
      const variant = variants.has(name) || /[-_](dark|tinted)\b/i.test(name) ? 1 : 0;
      out.push({ file, set, width, height, variant, exactName: set.endsWith("/AppIcon.appiconset"), depth });
    } catch {
      // Not a readable PNG; skip it.
    }
  }
  return out;
}

export async function findAppIcon(projectPath: string): Promise<AppIcon | null> {
  const root = searchRoot(projectPath);
  const sets = await findIconSets(root);
  const all = (await Promise.all(sets.map((s) => candidates(s.path, s.depth)))).flat();
  if (all.length === 0) return null;
  all.sort(
    (a, b) =>
      a.variant - b.variant ||
      Number(b.exactName) - Number(a.exactName) ||
      b.width * b.height - a.width * a.height ||
      a.depth - b.depth ||
      a.file.localeCompare(b.file),
  );
  const best = all[0]!;
  const png = await readFile(best.file);
  return { png: png.toString("base64"), width: best.width, height: best.height, file: relative(root, best.file) };
}
