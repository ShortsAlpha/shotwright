import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import type { XcodeProject } from "@shotwright/core";
import type { AgentLogger } from "./drivers.ts";
import { run, runStreaming } from "./exec.ts";
import { AgentError } from "./params.ts";

/** Derived data for every build lives here, one folder per project. */
export const DERIVED_DATA_ROOT = join(homedir(), "Library", "Caches", "Shotwright", "DerivedData");

const SKIP_DIRS = new Set(["node_modules", "Pods", "Carthage", "DerivedData", "build", "dist", "vendor"]);
const BUNDLE_EXTENSIONS = new Set([
  ".app", ".appex", ".bundle", ".docc", ".framework", ".lproj", ".playground", ".xcarchive",
  ".xcassets", ".xcframework", ".xcresult",
]);
const MAX_DEPTH = 5;
const MAX_PROJECTS = 40;
const MAX_DIRS = 20_000;

/** Finds .xcworkspace and .xcodeproj bundles under `root`, breadth first. */
async function findProjectPaths(root: string): Promise<string[]> {
  const found: string[] = [];
  let queue: string[] = [root];
  let visited = 0;
  for (let depth = 0; depth <= MAX_DEPTH && queue.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      if (++visited > MAX_DIRS || found.length >= MAX_PROJECTS) return found;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const names = new Set(entries.map((e) => e.name));
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const path = join(dir, entry.name);
        const ext = extname(entry.name);
        if (ext === ".xcworkspace") {
          found.push(path);
        } else if (ext === ".xcodeproj") {
          // A CocoaPods-style workspace next to the project already includes it.
          const stem = entry.name.slice(0, -ext.length);
          if (!names.has(`${stem}.xcworkspace`)) found.push(path);
        } else if (!SKIP_DIRS.has(entry.name) && !BUNDLE_EXTENSIONS.has(ext)) {
          next.push(path);
        }
      }
    }
    queue = next;
  }
  return found;
}

const containerFlag = (path: string) => (path.endsWith(".xcworkspace") ? "-workspace" : "-project");

/** Parses JSON from xcodebuild output that may start with log lines. */
function parseJsonOutput<T>(stdout: string): T {
  const start = stdout.search(/^[[{]/m);
  if (start < 0) throw new Error("xcodebuild printed no JSON");
  return JSON.parse(stdout.slice(start)) as T;
}

async function listSchemes(path: string): Promise<string[]> {
  const { stdout } = await run("xcodebuild", ["-list", "-json", containerFlag(path), path], { timeoutMs: 90_000 });
  const json = parseJsonOutput<{ project?: { schemes?: string[] }; workspace?: { schemes?: string[] } }>(stdout);
  return json.workspace?.schemes ?? json.project?.schemes ?? [];
}

/** Xcode projects and workspaces under `root`, with their schemes. */
export async function listProjects(root: string, log: AgentLogger): Promise<XcodeProject[]> {
  if (!root.startsWith("/")) throw new AgentError("root must be an absolute path");
  const paths = await findProjectPaths(root);
  const projects: XcodeProject[] = [];
  // Two at a time: xcodebuild -list can take several seconds per project.
  for (let i = 0; i < paths.length; i += 2) {
    const batch = paths.slice(i, i + 2);
    const results = await Promise.all(
      batch.map(async (path) => {
        try {
          return { path, schemes: await listSchemes(path) };
        } catch (error) {
          log("warn", `Could not list schemes of ${path}: ${error instanceof Error ? error.message : error}`);
          return { path, schemes: [] };
        }
      }),
    );
    projects.push(...results);
  }
  return projects;
}

export interface BuildParams {
  readonly projectPath: string;
  readonly scheme: string;
  readonly udid: string;
  readonly configuration: "Debug" | "Release";
}

interface BuildSettingsEntry {
  target?: string;
  buildSettings?: Record<string, string | undefined>;
}

/** Builds the scheme for the simulator and returns the .app path and bundle id. */
export async function buildApp(params: BuildParams, log: AgentLogger): Promise<{ appPath: string; bundleId: string }> {
  const { projectPath, scheme, udid, configuration } = params;
  if (!existsSync(projectPath)) throw new AgentError(`Project not found: ${projectPath}`, "not_found");

  const stem = basename(projectPath, extname(projectPath)).replace(/[^\w.-]+/g, "_");
  const hash = createHash("sha1").update(projectPath).digest("hex").slice(0, 8);
  const derivedData = join(DERIVED_DATA_ROOT, `${stem}-${hash}`);
  const common = [
    containerFlag(projectPath), projectPath,
    "-scheme", scheme,
    "-configuration", configuration,
    "-destination", `id=${udid}`,
    "-derivedDataPath", derivedData,
  ];

  log("info", `Building ${scheme} (${configuration}) from ${basename(projectPath)}`);
  const started = Date.now();
  let lastProgress = started;
  let errors = 0;
  const { code, tail } = await runStreaming("xcodebuild", [...common, "build"], {
    timeoutMs: 20 * 60_000,
    onLine: (line) => {
      if (/\berror: /.test(line) && errors++ < 10) {
        log("error", line.trim());
      } else if (Date.now() - lastProgress > 10_000) {
        lastProgress = Date.now();
        log("info", `Still building (${Math.round((lastProgress - started) / 1000)} s)`);
      }
    },
  });
  if (code !== 0) {
    const reason = tail.filter((l) => /\berror: |BUILD FAILED/.test(l)).slice(-3).join(" | ") || tail.slice(-3).join(" | ");
    throw new AgentError(`xcodebuild failed (exit ${code}): ${reason}`, "build_failed");
  }
  log("info", `Build succeeded in ${Math.round((Date.now() - started) / 1000)} s`);

  const { stdout } = await run("xcodebuild", [...common, "-showBuildSettings", "-json"], { timeoutMs: 120_000 });
  const entries = parseJsonOutput<BuildSettingsEntry[]>(stdout);
  const apps = entries.filter((e) => e.buildSettings?.WRAPPER_EXTENSION === "app");
  const entry = apps.find((e) => e.target === scheme) ?? apps[0];
  const settings = entry?.buildSettings;
  if (!settings?.TARGET_BUILD_DIR || !settings.FULL_PRODUCT_NAME) {
    throw new AgentError(`Scheme ${scheme} does not build an app`, "no_app");
  }
  const appPath = join(settings.TARGET_BUILD_DIR, settings.FULL_PRODUCT_NAME);
  if (!existsSync(appPath)) throw new AgentError(`Built app not found at ${appPath}`, "no_app");

  let bundleId = settings.PRODUCT_BUNDLE_IDENTIFIER ?? "";
  try {
    const plist = await run("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(appPath, "Info.plist")]);
    bundleId = plist.stdout.trim() || bundleId;
  } catch {
    // Fall back to the build setting.
  }
  if (!bundleId) throw new AgentError(`Could not read the bundle id of ${appPath}`, "no_app");
  return { appPath, bundleId };
}
