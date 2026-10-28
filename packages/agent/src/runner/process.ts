/**
 * Builds ShotwrightRunner once per Xcode version (and runner source hash), runs it with
 * `xcodebuild test-without-building` in the background, waits for `/health`, and restarts it
 * when it hangs. Commands: ios/ShotwrightRunner/README.md.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerStartError } from "./errors.ts";
import { exec } from "./exec.ts";
import { RunnerHttp } from "./http.ts";
import { terminateApp } from "./simctl.ts";

/** ios/ShotwrightRunner, from src/runner/ and from dist/runner/ alike. */
export const DEFAULT_PROJECT_DIR = fileURLToPath(new URL("../../../../ios/ShotwrightRunner/", import.meta.url));
const SCHEME = "ShotwrightRunner";
const ONLY_TESTING = "ShotwrightRunnerUITests/RunnerTests/testServe";
const UITEST_RUNNER_BUNDLE_ID = "dev.shotwright.RunnerUITests.xctrunner";

export interface RunnerProcessOptions {
  readonly udid: string;
  readonly port: number;
  /** Build products and logs. Default ~/Library/Caches/Shotwright/runner/xcode-<version>-<build>. */
  readonly derivedDataPath?: string;
  readonly projectDir?: string;
  readonly healthTimeoutMs?: number;
  readonly forceRebuild?: boolean;
  readonly log?: (message: string) => void;
}

interface BuildStamp {
  xcode: string;
  sourceHash: string;
  xctestrun: string;
  builtAt: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** "27.1-27A9275" from `xcodebuild -version`. */
export async function xcodeVersion(): Promise<string> {
  const { stdout } = await exec("xcodebuild", ["-version"], { timeoutMs: 30_000 });
  const version = /^Xcode\s+(\S+)/m.exec(stdout)?.[1] ?? "unknown";
  const build = /^Build version\s+(\S+)/m.exec(stdout)?.[1] ?? "unknown";
  return `${version}-${build}`;
}

function sourceHash(projectDir: string): string {
  const hash = createHash("sha1");
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "xcuserdata" || name === ".DS_Store" || name === "README.md") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else hash.update(relative(projectDir, path)).update("\0").update(readFileSync(path));
    }
  };
  walk(projectDir);
  return hash.digest("hex").slice(0, 10);
}

function listenerPids(port: number): number[] {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8", timeout: 5_000 });
    return out.split(/\s+/).filter(Boolean).map(Number).filter((pid) => pid > 0 && pid !== process.pid);
  } catch {
    return []; // lsof exits 1 when nothing listens
  }
}

function killPids(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

// Children we spawned, killed when this Node process exits so no xcodebuild is left behind.
const liveProcesses = new Set<RunnerProcess>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const runner of liveProcesses) runner.killNow();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    // Only take over the signal when nobody else handles it, and keep the default exit behaviour.
    if (process.listenerCount(signal) === 0) {
      process.once(signal, () => {
        for (const runner of liveProcesses) runner.killNow();
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    }
  }
}

export class RunnerProcess {
  readonly udid: string;
  readonly port: number;
  readonly projectDir: string;
  readonly http: RunnerHttp;
  derivedDataPath: string | undefined;
  /** xcodebuild output of the current run. */
  logPath: string | undefined;

  readonly #healthTimeoutMs: number;
  readonly #forceRebuild: boolean;
  readonly #log: (message: string) => void;
  #child: ChildProcess | undefined;
  #childExit: Promise<number | null> | undefined;
  #xctestrun: string | undefined;

  constructor(options: RunnerProcessOptions) {
    this.udid = options.udid;
    this.port = options.port;
    this.projectDir = options.projectDir ?? DEFAULT_PROJECT_DIR;
    this.derivedDataPath = options.derivedDataPath;
    this.http = new RunnerHttp(options.port);
    // The first test launch after a cold boot took 160 s on the 8 GB M2; later starts take 15-40 s.
    this.#healthTimeoutMs = options.healthTimeoutMs ?? 300_000;
    this.#forceRebuild = options.forceRebuild ?? false;
    this.#log = options.log ?? (() => undefined);
  }

  /** True when we spawned the runner (false when we adopted one already listening on the port). */
  get owned(): boolean {
    return this.#child !== undefined && this.#child.exitCode === null;
  }

  /** build-for-testing unless a build for this Xcode version and runner source already exists. */
  async build(): Promise<string> {
    const xcode = await xcodeVersion();
    const hash = sourceHash(this.projectDir);
    const dd = (this.derivedDataPath ??= join(homedir(), "Library", "Caches", "Shotwright", "runner", `xcode-${xcode}`));
    const stampPath = join(dd, "shotwright-runner.json");
    if (!this.#forceRebuild && existsSync(stampPath)) {
      const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as BuildStamp;
      if (stamp.xcode === xcode && stamp.sourceHash === hash && existsSync(stamp.xctestrun)) {
        this.#xctestrun = stamp.xctestrun;
        return stamp.xctestrun;
      }
    }
    mkdirSync(join(dd, "logs"), { recursive: true });
    const logPath = join(dd, "logs", `build-${Date.now()}.log`);
    this.#log(`building ShotwrightRunner for Xcode ${xcode} (log: ${logPath})`);
    const started = Date.now();
    const code = await this.#run(
      "xcodebuild",
      [
        "build-for-testing",
        "-project", join(this.projectDir, "ShotwrightRunner.xcodeproj"),
        "-scheme", SCHEME,
        "-destination", `platform=iOS Simulator,id=${this.udid}`,
        "-derivedDataPath", dd,
      ],
      logPath,
      15 * 60_000,
    );
    if (code !== 0) throw new RunnerStartError(`ShotwrightRunner build failed (exit ${code})`, logPath);
    const products = join(dd, "Build", "Products");
    const xctestrun = readdirSync(products).filter((f) => f.endsWith(".xctestrun")).map((f) => join(products, f))[0];
    if (!xctestrun) throw new RunnerStartError("build succeeded but produced no .xctestrun", logPath);
    const stamp: BuildStamp = { xcode, sourceHash: hash, xctestrun, builtAt: new Date().toISOString() };
    writeFileSync(stampPath, JSON.stringify(stamp, null, 2));
    this.#log(`built in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    this.#xctestrun = xctestrun;
    return xctestrun;
  }

  async healthy(timeoutMs = 2_000): Promise<boolean> {
    try {
      await this.http.json("GET", "/health", undefined, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /** Starts the runner unless one already answers on the port; resolves when `/health` answers. */
  async start(): Promise<void> {
    if (await this.healthy()) {
      if (!this.owned) this.#log(`a runner already answers on port ${this.port}; using it`);
      return;
    }
    // Something holds the port but does not answer: a hung runner from an earlier run.
    const stale = listenerPids(this.port);
    if (stale.length > 0) {
      this.#log(`killing unresponsive listener on port ${this.port} (pid ${stale.join(", ")})`);
      killPids(stale, "SIGKILL");
      await this.#waitPortFree(10_000);
    }
    const xctestrun = this.#xctestrun ?? (await this.build());
    const dd = this.derivedDataPath!;
    mkdirSync(join(dd, "logs"), { recursive: true });
    this.#pruneResults(join(dd, "results"));
    this.logPath = join(dd, "logs", `run-${Date.now()}.log`);
    const fd = openSync(this.logPath, "a");
    const child = spawn(
      "xcodebuild",
      [
        "test-without-building",
        "-xctestrun", xctestrun,
        "-destination", `platform=iOS Simulator,id=${this.udid}`,
        `-only-testing:${ONLY_TESTING}`,
        "-derivedDataPath", dd,
        "-resultBundlePath", join(dd, "results", `run-${Date.now()}.xcresult`),
      ],
      { env: { ...process.env, TEST_RUNNER_SHOTWRIGHT_PORT: String(this.port) }, stdio: ["ignore", fd, fd] },
    );
    closeSync(fd);
    child.unref();
    this.#child = child;
    this.#childExit = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    liveProcesses.add(this);
    installExitHook();
    this.#log(`starting runner on port ${this.port} (pid ${child.pid}, log: ${this.logPath})`);

    const started = Date.now();
    let nextNote = started + 30_000;
    while (Date.now() - started < this.#healthTimeoutMs) {
      if (Date.now() > nextNote) {
        this.#log(`still waiting for the runner (${Math.round((Date.now() - started) / 1000)} s)`);
        nextNote += 30_000;
      }
      if (child.exitCode !== null) {
        liveProcesses.delete(this);
        throw new RunnerStartError(`xcodebuild exited with ${child.exitCode} before the runner answered:\n${this.#logTail()}`, this.logPath);
      }
      if (await this.healthy(2_000)) {
        this.#log(`runner ready in ${((Date.now() - started) / 1000).toFixed(1)} s`);
        return;
      }
      await sleep(500);
    }
    await this.stop();
    throw new RunnerStartError(`runner did not answer /health within ${this.#healthTimeoutMs / 1000} s`, this.logPath);
  }

  /** Ends the runner: POST /shutdown, then SIGTERM/SIGKILL if xcodebuild does not exit. */
  async stop(): Promise<void> {
    try {
      await this.http.json("POST", "/shutdown", {}, 2_000);
    } catch {
      // hung or already gone
    }
    const child = this.#child;
    if (child && child.exitCode === null) {
      const exited = await Promise.race([this.#childExit, sleep(15_000).then(() => "timeout" as const)]);
      if (exited === "timeout") {
        child.kill("SIGTERM");
        const killed = await Promise.race([this.#childExit, sleep(5_000).then(() => "timeout" as const)]);
        if (killed === "timeout") child.kill("SIGKILL");
      }
    }
    if (!this.owned) liveProcesses.delete(this);
    this.#child = undefined;
  }

  /** Kills a hung runner (xcodebuild, the in-simulator runner process) and starts a fresh one. */
  async restart(): Promise<void> {
    this.#log("restarting runner");
    this.killNow();
    await terminateApp(this.udid, UITEST_RUNNER_BUNDLE_ID);
    await this.#waitPortFree(15_000);
    this.#child = undefined;
    await this.start();
  }

  /** Synchronous kill, safe in an exit handler. */
  killNow(): void {
    if (this.#child && this.#child.exitCode === null) this.#child.kill("SIGKILL");
    killPids(listenerPids(this.port), "SIGKILL");
    liveProcesses.delete(this);
  }

  #logTail(lines = 15): string {
    try {
      return readFileSync(this.logPath!, "utf8").trim().split("\n").slice(-lines).join("\n");
    } catch {
      return "";
    }
  }

  async #waitPortFree(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && listenerPids(this.port).length > 0) await sleep(300);
  }

  #pruneResults(dir: string, keep = 3): void {
    if (!existsSync(dir)) return;
    const bundles = readdirSync(dir).filter((f) => f.endsWith(".xcresult")).sort();
    for (const name of bundles.slice(0, Math.max(0, bundles.length - keep))) {
      rmSync(join(dir, name), { recursive: true, force: true });
    }
  }

  #run(file: string, args: string[], logPath: string, timeoutMs: number): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const fd = openSync(logPath, "a");
      const child = spawn(file, args, { stdio: ["ignore", fd, fd] });
      closeSync(fd);
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }
}
