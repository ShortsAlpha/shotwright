/** Builds a run's manifest.json (the renderer's entry point; the type is in artifacts.ts). */
import type { ScreenInfo, SimDevice } from "@shotwright/core";
import type { ExplorationResult, JudgeResult } from "@shotwright/explorer";
import type { Manifest } from "./artifacts.ts";
import type { ExploreParams } from "./state.ts";

export interface ManifestInput {
  readonly runId: string;
  readonly createdAt: number;
  readonly params: ExploreParams;
  readonly appName: string;
  readonly bundleId: string;
  readonly device: SimDevice | undefined;
  readonly screen: ScreenInfo;
  readonly result: ExplorationResult;
  readonly judge?: JudgeResult;
  readonly replays: ReadonlyMap<string, { readonly screenshots: ReadonlyArray<{ name: string; verified: boolean; file: string }> }>;
}

export function buildManifest(input: ManifestInput): Manifest {
  const { result, judge } = input;
  const records = new Map(result.screens.map((s) => [s.name, s]));
  const judged = judge?.ranking.filter((r) => records.has(r.name)) ?? [];
  const order = [...judged.map((r) => r.name), ...result.ranked, ...result.screens.map((s) => s.name)].filter(
    (name, i, all) => records.has(name) && all.indexOf(name) === i,
  );
  return {
    version: 1,
    runId: input.runId,
    createdAt: new Date(input.createdAt).toISOString(),
    updatedAt: new Date().toISOString(),
    app: {
      name: input.appName,
      bundleId: input.bundleId,
      projectPath: input.params.projectPath,
      scheme: input.params.scheme,
      launchArgs: input.params.launchArgs,
      description: input.params.hint,
    },
    device: {
      udid: input.params.udid,
      ...(input.device && { name: input.device.name }),
      ...(input.device?.setId && { setId: input.device.setId }),
      screen: { width: input.screen.width, height: input.screen.height },
    },
    explorationLocale: input.params.locales[0] ?? "en",
    explorer: { model: result.provider.model, costUsd: result.costUsd, stoppedBecause: result.stoppedBecause },
    rankedBy: judged.length > 0 ? "judge" : "explorer",
    screens: order.map((name, i) => {
      const record = records.get(name)!;
      const j = judged.find((r) => r.name === name);
      const locales: Record<string, { file: string; verified: boolean }> = {};
      for (const [locale, replay] of input.replays) {
        const shot = replay.screenshots.find((s) => s.name === name);
        if (shot) locales[locale] = { file: shot.file, verified: shot.verified };
      }
      return {
        name,
        rank: i + 1,
        score: j?.score ?? record.score,
        caption: j?.caption ?? "",
        why: record.why,
        file: `screens/${name}.png`,
        locales,
      };
    }),
    files: {
      exploration: "exploration.json",
      flow: "flow.json",
      ...(judge && { judge: "judge.json" }),
      ...(input.replays.size > 0 && { replay: "replay/replay.json" }),
    },
  };
}
