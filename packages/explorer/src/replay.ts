/**
 * Replays a recorded flow on any DeviceDriver, in any locale, and checks that every screenshot
 * step reached the screen the exploration marked:
 * - the flow's own `waitFor` anchor (an identifier only that screen has) must appear, and
 * - when the exploration's screen records are passed, the visible identifiers and the element
 *   type sequence (both locale-independent) must be similar to the recorded ones.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceDriver, ElementSelector, Flow, ScreenInfo, UISnapshot } from "@shotwright/core";
import { performSwipe, performType, planTap, resolveSelector, scrollIntoView } from "./actions.ts";
import { flatten, selectElements, stableIdentifiers, stableSource, type FlatNode } from "./observe.ts";
import type { ScreenRecord } from "./recorder.ts";

export interface Locale {
  /** e.g. "de", "ja", "zh-Hans". */
  readonly language: string;
  /** e.g. "DE"; defaults to the language's usual region for a few common languages. */
  readonly region?: string;
}

export interface ReplayOptions {
  readonly locale?: Locale;
  /** Replaces the launch arguments recorded in the flow. */
  readonly launchArgs?: readonly string[];
  /** Appended to the launch arguments. */
  readonly extraLaunchArgs?: readonly string[];
  /** The exploration's screen records, to verify each screenshot. */
  readonly screens?: readonly ScreenRecord[];
  /** Writes <name>.png here. */
  readonly outDir?: string;
  /** How long to wait for a tap target with an identifier to appear. Default 8 s. */
  readonly findTimeoutMs?: number;
  readonly stopOnError?: boolean;
  readonly log?: (message: string) => void;
}

export interface ReplayCheck {
  readonly anchor?: { id: string; found: boolean };
  readonly identifierSimilarity?: number;
  readonly structureSimilarity?: number;
}

export interface ReplayShot {
  readonly name: string;
  readonly png: Uint8Array;
  readonly file?: string;
  readonly verified: boolean;
  readonly checks: ReplayCheck;
}

export interface ReplayStepResult {
  readonly index: number;
  readonly action: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail?: string;
}

export interface ReplayResult {
  readonly ok: boolean;
  readonly locale: Locale | undefined;
  readonly launchArgs: readonly string[];
  readonly screenshots: ReplayShot[];
  readonly steps: ReplayStepResult[];
  readonly totalMs: number;
}

const DEFAULT_REGION: Record<string, string> = {
  en: "US", de: "DE", ja: "JP", fr: "FR", es: "ES", it: "IT", ko: "KR", nl: "NL", pl: "PL", pt: "BR",
  ru: "RU", sv: "SE", tr: "TR", ar: "SA", hi: "IN", "zh-Hans": "CN",
};

/** `-AppleLanguages (de) -AppleLocale de_DE`. */
export function localeArgs(locale: Locale): string[] {
  const region = locale.region ?? DEFAULT_REGION[locale.language] ?? "US";
  const base = locale.language.split("-")[0];
  return ["-AppleLanguages", `(${locale.language})`, "-AppleLocale", `${base}_${region}`];
}

function lcs(a: readonly string[], b: readonly string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(row[j]!, row[j - 1]!);
      prev = tmp;
    }
  }
  return row[b.length]!;
}

export function structureSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  return (2 * lcs(a, b)) / (a.length + b.length);
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let both = 0;
  for (const x of A) if (B.has(x)) both++;
  return both / (A.size + B.size - both);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export async function replayFlow(driver: DeviceDriver, flow: Flow, options: ReplayOptions = {}): Promise<ReplayResult> {
  const log = options.log ?? (() => undefined);
  const started = Date.now();
  const screen: ScreenInfo = await driver.screen();
  const steps: ReplayStepResult[] = [];
  const screenshots: ReplayShot[] = [];
  const findTimeout = options.findTimeoutMs ?? 8_000;
  let bundleId = "";
  let launchArgs: string[] = [];
  let lastAnchor: { id: string; found: boolean } | undefined;
  let failed = false;
  if (options.outDir) mkdirSync(options.outDir, { recursive: true });

  const snapshotNodes = async (): Promise<{ snapshot: UISnapshot; nodes: FlatNode[] }> => {
    const snapshot = await stableSource(driver, bundleId);
    return { snapshot, nodes: flatten(snapshot.tree) };
  };

  /** Waits until the selector resolves. Identifiers are locale-independent, so keep polling for them; a missing label is given up on after one stable look. */
  const find = async (selector: ElementSelector, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { nodes } = await snapshotNodes();
      const node = resolveSelector(nodes, selector, screen);
      if (node || selector.id === undefined || Date.now() > deadline) return { node, nodes };
      await new Promise((r) => setTimeout(r, 400));
    }
  };

  for (const [index, step] of flow.steps.entries()) {
    if (failed && options.stopOnError) break;
    const t0 = Date.now();
    const record = (ok: boolean, detail?: string) => {
      steps.push({ index, action: step.action, ok, ms: Date.now() - t0, ...(detail ? { detail } : {}) });
      log(`  ${String(index).padStart(2)} ${step.action.padEnd(10)} ${ok ? "ok  " : "FAIL"} ${Date.now() - t0} ms${detail ? `  ${detail}` : ""}`);
      if (!ok) failed = true;
    };
    try {
      switch (step.action) {
        case "launch": {
          bundleId = step.bundleId;
          launchArgs = [...(options.launchArgs ?? step.args), ...(options.extraLaunchArgs ?? []), ...(options.locale ? localeArgs(options.locale) : [])];
          await driver.launch({ bundleId, args: launchArgs });
          record(true);
          break;
        }
        case "tap": {
          let { nodes } = step.target.id !== undefined ? await find(step.target, findTimeout) : await snapshotNodes();
          // A target that exists but is scrolled away (or under the tab bar) is scrolled into view
          // instead of tapping the recorded point, which would hit whatever is there now.
          let scrolls = 0;
          for (; scrolls < 4; scrolls++) {
            const node = resolveSelector(nodes, step.target, screen, step.fallback);
            const scroll = node ? scrollIntoView(node, nodes, screen) : undefined;
            if (!scroll) break;
            await performSwipe(driver, scroll, nodes, screen);
            ({ nodes } = await snapshotNodes());
          }
          const plan = planTap(step, nodes, screen);
          await driver.tap({ x: Math.round(plan.point.x * 10) / 10, y: Math.round(plan.point.y * 10) / 10 });
          const where = `(${Math.round(plan.point.x)},${Math.round(plan.point.y)})`;
          record(true, `${JSON.stringify(step.target).slice(0, 80)} via ${plan.via} at ${where}${scrolls ? ` after ${scrolls} scroll(s)` : ""}`);
          break;
        }
        case "swipe": {
          const { nodes } = await snapshotNodes();
          await performSwipe(driver, step, nodes, screen);
          record(true, `${step.direction} ${step.distance}`);
          break;
        }
        case "typeText":
          await performType(driver, step);
          record(true);
          break;
        case "waitFor": {
          const { node } = await find(step.target, step.timeoutMs);
          lastAnchor = { id: step.target.id ?? step.target.label ?? "", found: node !== undefined };
          record(node !== undefined, JSON.stringify(step.target));
          break;
        }
        case "screenshot": {
          const { nodes, snapshot } = await snapshotNodes();
          const png = await driver.screenshot();
          const expected = options.screens?.find((s) => s.name === step.name);
          const identifiers = stableIdentifiers(nodes, screen);
          const structure = selectElements(nodes, screen).map((n) => n.type);
          const checks: ReplayCheck = {
            ...(lastAnchor ? { anchor: lastAnchor } : {}),
            ...(expected
              ? {
                  identifierSimilarity: round2(jaccard(expected.identifiers, identifiers)),
                  structureSimilarity: round2(structureSimilarity(expected.structure, structure)),
                }
              : {}),
          };
          const verified =
            snapshot.state === "foreground" &&
            (checks.anchor?.found ?? true) &&
            (checks.structureSimilarity ?? 1) >= 0.6 &&
            (expected === undefined || expected.identifiers.length === 0 || (checks.identifierSimilarity ?? 1) >= 0.5);
          let file: string | undefined;
          if (options.outDir) {
            file = join(options.outDir, `${step.name}.png`);
            writeFileSync(file, png);
          }
          screenshots.push({ name: step.name, png, verified, checks, ...(file ? { file } : {}) });
          lastAnchor = undefined;
          record(verified, `${step.name} ${JSON.stringify(checks)}`);
          break;
        }
      }
    } catch (error) {
      record(false, (error as Error).message.slice(0, 300));
    }
  }

  return {
    ok: !failed && screenshots.length === flow.steps.filter((s) => s.action === "screenshot").length,
    locale: options.locale,
    launchArgs,
    screenshots,
    steps,
    totalMs: Date.now() - started,
  };
}
