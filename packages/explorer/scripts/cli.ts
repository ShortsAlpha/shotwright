/**
 * Shotwright explorer CLI: explore an app, replay the recorded flow per locale, judge screens.
 *
 *   node packages/explorer/scripts/cli.ts explore --udid <UDID> --bundle <id> --model spark --out <dir> \
 *     [--app-path <App.app>] [--args "-seedSampleData -inMemoryStore"] [--app-name Renew] [--hint "..."] \
 *     [--max-steps 40] [--max-cost 1.5] [--effort low] [--judge] [--no-settle] [--no-scroll-top]
 *   node packages/explorer/scripts/cli.ts replay --udid <UDID> --exploration <dir>/exploration.json --out <dir> \
 *     [--locales en,de,ja] [--args "-seedSampleData -sampleRegion {region}"] \
 *     [--repair spark|open|none] [--repair-max-cost 0.10] [--repair-attempts 2] [--flow <flow.json>] \
 *     [--no-settle] [--no-save-repairs]   (successful repairs go to <exploration dir>/flow.repaired.json)
 *   node packages/explorer/scripts/cli.ts judge --exploration <dir>/exploration.json [--app-name Renew]
 *   node packages/explorer/scripts/cli.ts rebuild --exploration <dir>/exploration.json   (flow from the saved graph)
 *
 * Models: spark (muse-spark-1.3), wonder (muse-wonder-1.0), open (Muse Spark Open on Baseten),
 * open-json (Spark Open with JSON actions instead of tools). Keys come from the repo's .env.local.
 * In --args, {language} and {region} are replaced per locale during replay.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { FlowSchema } from "@shotwright/core";
import type { ReasoningEffort } from "@shotwright/muse";
import { ensureRunner, simctl } from "../../agent/src/runner/index.ts";
import { FlowRecorder, createProvider, explore, judgeScreens, replayFlow, type ExplorationResult, type JudgeResult, type ReplayResult } from "../src/index.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
try {
  process.loadEnvFile(join(repoRoot, ".env.local"));
} catch {
  // keys may come from the environment
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    udid: { type: "string" },
    bundle: { type: "string" },
    "app-path": { type: "string" },
    "app-name": { type: "string" },
    model: { type: "string", default: "spark" },
    effort: { type: "string" },
    args: { type: "string" },
    hint: { type: "string" },
    out: { type: "string" },
    "max-steps": { type: "string", default: "40" },
    "max-cost": { type: "string", default: "1.5" },
    "image-scale": { type: "string" },
    exploration: { type: "string" },
    locales: { type: "string", default: "en" },
    judge: { type: "boolean", default: false },
    "no-status-bar": { type: "boolean", default: false },
    "no-verify": { type: "boolean", default: false },
    repair: { type: "string", default: "spark" },
    "no-settle": { type: "boolean", default: false },
    "no-scroll-top": { type: "boolean", default: false },
    "no-save-repairs": { type: "boolean", default: false },
    "repair-max-cost": { type: "string", default: "0.10" },
    "repair-attempts": { type: "string", default: "2" },
    flow: { type: "string" },
  },
});

const command = positionals[0];
const cwd = process.env.INIT_CWD ?? process.cwd();
const abs = (p: string) => resolve(cwd, p);
const splitArgs = (s: string | undefined) => (s ? s.split(/\s+/).filter(Boolean) : undefined);
function need(name: keyof typeof values): string {
  const v = values[name];
  if (typeof v !== "string" || v === "") {
    console.error(`--${name} is required`);
    process.exit(2);
  }
  return v;
}

let logFile: string | undefined;
const log = (message: string) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${message}`;
  console.log(line);
  if (logFile) appendFileSync(logFile, `${line}\n`);
};

function statusBar(udid: string, on: boolean): void {
  const args = on
    ? ["simctl", "status_bar", udid, "override", "--time", "9:41", "--batteryState", "discharging", "--batteryLevel", "100",
       "--dataNetwork", "5g", "--wifiBars", "3", "--cellularMode", "active", "--cellularBars", "4", "--operatorName", ""]
    : ["simctl", "status_bar", udid, "clear"];
  try {
    execFileSync("xcrun", args, { stdio: "ignore", timeout: 20_000 });
  } catch (error) {
    log(`status bar ${on ? "override" : "clear"} failed: ${(error as Error).message}`);
  }
}

async function runJudge(exploration: ExplorationResult, dir: string): Promise<JudgeResult | undefined> {
  const screens = exploration.ranked
    .map((name) => exploration.screens.find((s) => s.name === name))
    .filter((s) => s !== undefined)
    .map((s) => ({ name: s.name, why: s.why, png: new Uint8Array(readFileSync(join(dir, "screens", `${s.name}.png`))) }));
  if (screens.length === 0) {
    log("judge: no screens");
    return undefined;
  }
  log(`judge: sending ${screens.length} screens to Muse Spark Open`);
  const judged = await judgeScreens({ screens, ...(exploration.app.appName ? { appName: exploration.app.appName } : {}) });
  writeFileSync(join(dir, "judge.json"), JSON.stringify(judged, null, 2));
  for (const r of judged.ranking) log(`  ${r.rank}. ${r.name} (${r.score}/10) "${r.caption}" - ${r.reason}`);
  log(`judge: ${judged.ms} ms, in ${judged.usage.input} out ${judged.usage.output}, list price $${judged.listCostUsd.toFixed(4)} (free credits)`);
  return judged;
}

/** Per locale: how each tap was resolved, screens verified, repair cost, capture settling. */
function tally(locale: string, result: ReplayResult): Record<string, string | number> {
  const taps = { id: 0, structure: 0, label: 0, repair: 0, fallback: 0, point: 0, failed: 0 };
  for (const step of result.steps) {
    if (step.action !== "tap") continue;
    if (!step.ok) taps.failed++;
    else if (step.via) taps[step.via]++;
  }
  const shots = result.screenshots;
  return {
    locale,
    ...taps,
    screenRepairs: result.steps.filter((s) => s.action === "screenshot" && s.repair).length,
    screens: `${shots.filter((s) => s.verified).length}/${shots.length}`,
    captureFrames: shots.map((s) => s.capture?.frames ?? 1).join("/"),
    captureCapHit: shots.filter((s) => s.capture && !s.capture.settled).length,
    scrolledToTop: shots.filter((s) => s.scrolledToTop).length + result.steps.filter((s) => s.action === "scrollToTop" && s.detail !== "already").length,
    seconds: Math.round(result.totalMs / 1000),
    repairUsd: Math.round(result.repairCostUsd * 10_000) / 10_000,
    repairListUsd: Math.round(result.repairs.reduce((sum, r) => sum + r.listCostUsd, 0) * 10_000) / 10_000,
  };
}

async function main(): Promise<number> {
  switch (command) {
    case "explore": {
      const udid = need("udid");
      const bundleId = need("bundle");
      const out = abs(need("out"));
      mkdirSync(out, { recursive: true });
      logFile = join(out, "log.txt");
      const runner = await ensureRunner({ udid, log });
      try {
        if (values["app-path"]) {
          log(`installing ${values["app-path"]}`);
          await simctl.installApp(udid, abs(values["app-path"]));
        }
        if (!values["no-status-bar"]) statusBar(udid, true);
        const provider = createProvider(values.model!, values.effort ? { reasoningEffort: values.effort as ReasoningEffort } : {});
        log(`exploring ${bundleId} with ${provider.id} (${provider.model}, ${provider.mode})`);
        const result = await explore({
          driver: runner.driver,
          provider,
          bundleId,
          launchArgs: splitArgs(values.args) ?? [],
          ...(values["app-name"] ? { appName: values["app-name"] } : {}),
          ...(values.hint ? { hint: values.hint } : {}),
          maxSteps: Number(values["max-steps"]),
          maxCostUsd: Number(values["max-cost"]),
          ...(values["image-scale"] ? { imageScale: Number(values["image-scale"]) } : {}),
          outDir: out,
          verify: !values["no-verify"],
          ...(values["no-settle"] ? { settle: false as const } : {}),
          ...(values["no-scroll-top"] ? { scrollToTop: false } : {}),
          log,
        });
        log(
          `done (${result.stoppedBecause}): ${result.turns} turns, ${result.actions} actions, ${result.screens.length} screens, ` +
            `flow ${result.flow.steps.length} steps, ${(result.timing.totalMs / 1000).toFixed(0)} s ` +
            `(model ${(result.timing.modelMs / 1000).toFixed(0)} s, device ${(result.timing.deviceMs / 1000).toFixed(0)} s)`,
        );
        log(
          `tokens: in ${result.usage.input} (cached ${result.usage.cachedInput}), out ${result.usage.output} (reasoning ${result.usage.reasoning}); ` +
            `cost $${result.costUsd.toFixed(4)} (list $${result.listCostUsd.toFixed(4)})`,
        );
        if (result.verification) {
          const v = result.verification;
          log(`verification: ${v.rounds} round(s), ${(v.ms / 1000).toFixed(0)} s, literal paths for [${v.literal.join(", ")}], failing [${v.failed.join(", ")}]`);
        }
        log(`ranked: ${result.ranked.join(", ")}`);
        if (result.notes) log(`notes: ${result.notes}`);
        for (const w of result.warnings) log(`warning: ${w}`);
        if (result.error) log(`error: ${result.error}`);
        if (values.judge) await runJudge(result, out);
      } finally {
        await runner.stop();
      }
      return 0;
    }
    case "replay": {
      const udid = need("udid");
      const explorationPath = abs(need("exploration"));
      const exploration = JSON.parse(readFileSync(explorationPath, "utf8")) as ExplorationResult;
      const flow = FlowSchema.parse(values.flow ? JSON.parse(readFileSync(abs(values.flow), "utf8")) : exploration.flow);
      const dir = dirname(explorationPath);
      const out = abs(need("out"));
      mkdirSync(out, { recursive: true });
      logFile = join(out, "log.txt");
      // Repair references: the screenshot each step was recorded on (steps/NNN.jpg).
      // A flow passed with --flow keeps the step order of the exploration's flow when it has as many steps.
      const sources = flow.steps.length === exploration.flow.steps.length ? exploration.stepSources : undefined;
      // Reference images come from <dir>/steps/NNN.jpg via runDir + stepSources (replayFlow's defaults).
      const repairModel = values.repair!;
      const repair =
        repairModel === "none"
          ? undefined
          : {
              provider: repairModel === "open" ? ("open" as const) : ("spark" as const),
              maxCostUsd: Number(values["repair-max-cost"]),
              maxAttemptsPerStep: Number(values["repair-attempts"]),
            };
      const runner = await ensureRunner({ udid, log });
      const summary: unknown[] = [];
      const matrix: Array<Record<string, string | number>> = [];
      try {
        if (!values["no-status-bar"]) statusBar(udid, true);
        for (const spec of values.locales!.split(",")) {
          const [language, region] = spec.split("_") as [string, string | undefined];
          const locale = { language, ...(region ? { region } : {}) };
          const argsTemplate = values.args;
          const regionCode =
            region ?? ({ en: "US", de: "DE", ja: "JP", fr: "FR", es: "ES", tr: "TR", ar: "SA", it: "IT", ko: "KR", nl: "NL", pt: "BR", ru: "RU", sv: "SE", hi: "IN", "zh-Hans": "CN" } as Record<string, string>)[language] ?? "US";
          const launchArgs = argsTemplate ? splitArgs(argsTemplate.replaceAll("{language}", language).replaceAll("{region}", regionCode)) : undefined;
          log(`replay ${spec}${launchArgs ? ` with ${launchArgs.join(" ")}` : ""}${repair ? `, repair with ${repair.provider} (max $${repair.maxCostUsd})` : ", no repair"}`);
          const result = await replayFlow(runner.driver, flow, {
            locale,
            ...(launchArgs ? { launchArgs } : {}),
            screens: exploration.screens,
            outDir: join(out, spec),
            runDir: dir,
            ...(sources ? { stepSources: sources } : {}),
            ...(repair ? { repair } : {}),
            ...(values["no-settle"] ? { settle: false as const } : {}),
            ...(values["no-save-repairs"] ? { saveRepairs: false } : {}),
            log,
          });
          const verified = result.screenshots.filter((s) => s.verified).length;
          const row = tally(spec, result);
          matrix.push(row);
          log(
            `replay ${spec}: ${result.ok ? "ok" : "FAILED"}, ${verified}/${result.screenshots.length} screenshots verified, ${(result.totalMs / 1000).toFixed(1)} s; ` +
              `taps: ${Object.entries(row).filter(([k]) => ["id", "structure", "label", "repair", "fallback", "point", "failed"].includes(k)).map(([k, v]) => `${k} ${v}`).join(", ")}; ` +
              `capture frames ${row.captureFrames} (cap hit ${row.captureCapHit}); repair $${result.repairCostUsd.toFixed(4)}` +
              (result.repairedFlowFile ? `; repaired flow: ${result.repairedFlowFile}` : ""),
          );
          summary.push({
            locale: spec,
            ok: result.ok,
            totalMs: result.totalMs,
            launchArgs: result.launchArgs,
            tally: row,
            repairCostUsd: result.repairCostUsd,
            repairs: result.repairs,
            steps: result.steps,
            screenshots: result.screenshots.map(({ png: _png, ...rest }) => rest),
          });
        }
        writeFileSync(join(out, "replay.json"), JSON.stringify(summary, null, 2));
        log("matrix:");
        for (const row of matrix) log(`  ${JSON.stringify(row)}`);
      } finally {
        await runner.stop();
      }
      return 0;
    }
    case "rebuild": {
      // Rebuilds flow.json and the screen records from the saved graph (after changing the recorder).
      const explorationPath = abs(need("exploration"));
      const exploration = JSON.parse(readFileSync(explorationPath, "utf8")) as ExplorationResult;
      const recorder = FlowRecorder.fromJSON(exploration.graph);
      const launch = { action: "launch" as const, bundleId: exploration.app.bundleId, args: [...exploration.app.launchArgs] };
      const literal = new Set(exploration.verification?.literal ?? []);
      const looseLiteral = new Set(exploration.verification?.looseLiteral ?? []);
      const built = recorder.build(exploration.flow.name, launch, { literal, looseLiteral });
      const updated = { ...exploration, flow: built.flow, screens: built.screens, stepSources: built.sources };
      writeFileSync(explorationPath, JSON.stringify(updated, null, 2));
      writeFileSync(join(dirname(explorationPath), "flow.json"), JSON.stringify(built.flow, null, 2));
      log(`rebuilt: ${built.flow.steps.length} steps (was ${exploration.flow.steps.length}); ${built.warnings.join("; ") || "no warnings"}`);
      return 0;
    }
    case "judge": {
      const explorationPath = abs(need("exploration"));
      const exploration = JSON.parse(readFileSync(explorationPath, "utf8")) as ExplorationResult;
      if (values["app-name"]) (exploration.app as { appName?: string }).appName = values["app-name"];
      logFile = join(dirname(explorationPath), "log.txt");
      await runJudge(exploration, dirname(explorationPath));
      return 0;
    }
    default:
      console.error("usage: cli.ts explore|replay|judge|rebuild [options] (see the header of packages/explorer/scripts/cli.ts)");
      return 2;
  }
}

process.exitCode = await main();
