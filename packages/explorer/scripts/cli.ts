/**
 * Shotwright explorer CLI: explore an app, replay the recorded flow per locale, judge screens.
 *
 *   node packages/explorer/scripts/cli.ts explore --udid <UDID> --bundle <id> --model spark --out <dir> \
 *     [--app-path <App.app>] [--args "-seedSampleData -inMemoryStore"] [--app-name Renew] [--hint "..."] \
 *     [--max-steps 40] [--max-cost 1.5] [--effort low] [--judge]
 *   node packages/explorer/scripts/cli.ts replay --udid <UDID> --exploration <dir>/exploration.json --out <dir> \
 *     [--locales en,de,ja] [--args "-seedSampleData -sampleRegion {region}"]
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
import { FlowRecorder, createProvider, explore, judgeScreens, replayFlow, type ExplorationResult, type JudgeResult } from "../src/index.ts";

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
      const flow = FlowSchema.parse(exploration.flow);
      const out = abs(need("out"));
      mkdirSync(out, { recursive: true });
      logFile = join(out, "log.txt");
      const runner = await ensureRunner({ udid, log });
      const summary: unknown[] = [];
      try {
        if (!values["no-status-bar"]) statusBar(udid, true);
        for (const spec of values.locales!.split(",")) {
          const [language, region] = spec.split("_") as [string, string | undefined];
          const locale = { language, ...(region ? { region } : {}) };
          const argsTemplate = values.args;
          const regionCode = region ?? ({ en: "US", de: "DE", ja: "JP", fr: "FR", es: "ES", tr: "TR" } as Record<string, string>)[language] ?? "US";
          const launchArgs = argsTemplate ? splitArgs(argsTemplate.replaceAll("{language}", language).replaceAll("{region}", regionCode)) : undefined;
          log(`replay ${spec}${launchArgs ? ` with ${launchArgs.join(" ")}` : ""}`);
          const result = await replayFlow(runner.driver, flow, {
            locale,
            ...(launchArgs ? { launchArgs } : {}),
            screens: exploration.screens,
            outDir: join(out, spec),
            log,
          });
          const verified = result.screenshots.filter((s) => s.verified).length;
          log(`replay ${spec}: ${result.ok ? "ok" : "FAILED"}, ${verified}/${result.screenshots.length} screenshots verified, ${(result.totalMs / 1000).toFixed(1)} s`);
          summary.push({
            locale: spec,
            ok: result.ok,
            totalMs: result.totalMs,
            launchArgs: result.launchArgs,
            steps: result.steps,
            screenshots: result.screenshots.map(({ png: _png, ...rest }) => rest),
          });
        }
        writeFileSync(join(out, "replay.json"), JSON.stringify(summary, null, 2));
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
      const built = recorder.build(exploration.flow.name, launch, { literal });
      const updated = { ...exploration, flow: built.flow, screens: built.screens };
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
