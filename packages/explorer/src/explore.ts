/**
 * The exploration loop: observe, ask the model for one action, run it through the same step
 * executors the replayer uses, record the transition, repeat. Ends when the model calls `done`,
 * or at the step, cost or text-reply limits. Works with any DeviceDriver and any provider.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceDriver, Flow, LaunchStep, ScreenInfo, SwipeStep, TapStep, TypeTextStep } from "@shotwright/core";
import { nodeAt, normalize, performSwipe, performTap, performType, selectorFor, swipeStepFromPoints, tapStepForNode } from "./actions.ts";
import { fromGrid, observe, type Observation, type ObservedElement } from "./observe.ts";
import { addUsage, emptyUsage, type ExplorerProvider, type HistoryItem, type ObservationPayload, type ToolCall, type Usage } from "./providers/types.ts";
import { FlowRecorder, type RecorderGraph, type ScreenRecord } from "./recorder.ts";
import { replayFlow, type ReplayCheck } from "./replay.ts";
import { TOOLS, parseToolInput, sanitizeName, type ToolInput } from "./tools.ts";

export interface ExploreOptions {
  readonly driver: DeviceDriver;
  readonly provider: ExplorerProvider;
  readonly bundleId: string;
  readonly launchArgs?: readonly string[];
  readonly appName?: string;
  /** Model turns. Default 40. */
  readonly maxSteps?: number;
  /** Stop when the run has cost this much (USD). Default 1.5. */
  readonly maxCostUsd?: number;
  readonly targetScreens?: number;
  readonly maxScreens?: number;
  /** Extra guidance about the app (what it does, what demo data it has). */
  readonly hint?: string;
  /** Writes exploration.json, flow.json, screens/*.png and steps/*.jpg here. */
  readonly outDir?: string;
  readonly imageScale?: number;
  /** Replay the recorded flow once at the end and repair screens that fail. Default true. */
  readonly verify?: boolean;
  readonly log?: (message: string) => void;
  readonly onEvent?: (event: ExploreEvent) => void;
}

export type ExploreEvent =
  | { readonly kind: "observation"; readonly index: number; readonly title: string | undefined; readonly image: Uint8Array }
  | { readonly kind: "turn"; readonly turn: number; readonly text: string; readonly calls: ReadonlyArray<{ name: string; args: Record<string, unknown> }> }
  | { readonly kind: "action"; readonly turn: number; readonly name: string; readonly output: string; readonly reason?: string }
  | { readonly kind: "mark"; readonly name: string; readonly score: number; readonly why: string; readonly png: Uint8Array };

export interface StepLog {
  readonly turn: number;
  readonly modelMs: number;
  readonly deviceMs: number;
  readonly usage: Usage;
  readonly text: string;
  readonly reasoning?: string;
  readonly calls: ReadonlyArray<{ name: string; args: Record<string, unknown>; output: string }>;
  readonly observation?: { index: number; fingerprint: string; title: string | undefined; changed: boolean };
}

export interface ExplorationResult {
  readonly app: { bundleId: string; launchArgs: readonly string[]; appName: string | undefined };
  readonly provider: { id: string; model: string; mode: string };
  readonly screen: ScreenInfo;
  readonly flow: Flow;
  readonly screens: ScreenRecord[];
  /** Marked screen names, best first (the model's ranking from `done`, else by score). */
  readonly ranked: string[];
  readonly notes: string;
  readonly stoppedBecause: "done" | "max_steps" | "budget" | "text_replies" | "error";
  readonly error?: string;
  readonly warnings: string[];
  readonly turns: number;
  readonly actions: number;
  readonly usage: Usage;
  readonly costUsd: number;
  readonly listCostUsd: number;
  readonly timing: { totalMs: number; modelMs: number; deviceMs: number };
  readonly steps: StepLog[];
  /** States, transitions and marks, to rebuild the flow later (FlowRecorder.fromJSON). */
  readonly graph: RecorderGraph;
  /** The verification replay (same device and locale) and what it changed. */
  readonly verification?: {
    rounds: number;
    ms: number;
    /** Screens rebuilt from their literal path after the shortcut failed. */
    literal: string[];
    failed: string[];
    screenshots: Array<{ name: string; verified: boolean; checks: ReplayCheck }>;
  };
}

function instructions(options: ExploreOptions, maxSteps: number, target: number, max: number): string {
  return [
    `You are Shotwright's exploration agent. You drive an iOS app${options.appName ? ` ("${options.appName}")` : ""} in the iOS Simulator to find the screens that make the best App Store screenshots.`,
    "",
    "Each observation has a screenshot and the visible accessibility elements, one per line:",
    '  e7 button "Add" #home.add (912,64)',
    "= ref, type, label, #accessibility identifier (if any), centre on a 0-1000 grid (x from the left, y from the top). Refs are renumbered every observation: only use refs from the latest one.",
    "",
    "How to work:",
    "- Every turn, call exactly one action tool: tap (by ref, preferred), tap_at (0-1000 grid, only for things missing from the list), swipe, type_text or relaunch. You may add mark_screen in the same turn; it applies to the current screen, before the action.",
    "- Mark a screen as soon as it is a strong candidate, then move on. Look for the main overview, rich detail screens, charts and insights, calendars or timelines, creation flows showing appealing content, and whatever is distinctive about this app.",
    "- Prefer screens full of realistic content. Avoid empty states, settings lists, legal pages, paywalls, system dialogs, loading states and keyboards covering content. Every marked screen must look clearly different from the others.",
    `- Mark about ${target} screens (at most ${max}); the first three shown in the App Store matter most. You have about ${maxSteps} turns in total, so don't wander: once you have enough strong screens, call done with the marked names ranked best first.`,
    "- Never delete data, buy anything, sign out, change system settings, send messages or leave the app. If you end up outside the app, relaunch. Dismiss permission prompts with the least-privileged choice (\"Not Now\", \"Don't Allow\"). Close sheets with their Cancel/Close/Done buttons.",
    "- To go back, tap the back button in the navigation bar (usually top left). If an action did not change the screen, try something else instead of repeating it.",
    options.hint ? `\nAbout this app: ${options.hint}` : "",
  ].join("\n");
}

function payload(observation: Observation): ObservationPayload {
  return { index: observation.index, text: observation.text, summary: observation.summary, image: observation.image };
}

const describe = (el: ObservedElement) => `${el.ref} (${el.type}${el.label ? ` "${el.label.slice(0, 40)}"` : ""}${el.identifier ? ` #${el.identifier}` : ""})`;
const ACTIONS = new Set(["tap", "tap_at", "swipe", "type_text", "relaunch"]);

export async function explore(options: ExploreOptions): Promise<ExplorationResult> {
  const { driver, provider, bundleId } = options;
  const launchArgs = options.launchArgs ?? [];
  const maxSteps = options.maxSteps ?? 40;
  const maxCost = options.maxCostUsd ?? 1.5;
  const target = options.targetScreens ?? 6;
  const maxScreens = options.maxScreens ?? 8;
  const log = options.log ?? (() => undefined);
  const emit = options.onEvent ?? (() => undefined);
  const out = options.outDir;
  if (out) {
    mkdirSync(join(out, "screens"), { recursive: true });
    mkdirSync(join(out, "steps"), { recursive: true });
  }

  const started = Date.now();
  let modelMs = 0;
  let deviceMs = 0;
  const usage = emptyUsage();
  const steps: StepLog[] = [];
  const warnings: string[] = [];
  const recorder = new FlowRecorder();
  const launch: LaunchStep = { action: "launch", bundleId, args: [...launchArgs] };
  const screen = await driver.screen();
  const observeOptions = (index: number) => ({ bundleId, screen, index, ...(options.imageScale ? { imageScale: options.imageScale } : {}) });

  const timed = async <T>(fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      deviceMs += Date.now() - t0;
    }
  };
  const saveStepImage = (observation: Observation) => {
    if (out) {
      const base = join(out, "steps", String(observation.index).padStart(3, "0"));
      writeFileSync(`${base}.jpg`, observation.image);
      writeFileSync(`${base}.txt`, `${observation.text}\n\nfingerprint ${observation.fingerprint}\n`);
    }
    emit({ kind: "observation", index: observation.index, title: observation.title, image: observation.image });
  };

  await timed(() => driver.launch({ bundleId, args: launchArgs }));
  let obs = await timed(() => observe(driver, observeOptions(0)));
  saveStepImage(obs);
  recorder.noteState(obs);
  recorder.recordLaunch(obs.fingerprint);
  log(`start: ${obs.elements.length} elements, title ${obs.title ?? "-"}`);

  const system = instructions(options, maxSteps, target, maxScreens);
  const history: HistoryItem[] = [
    {
      kind: "user",
      text: `Explore the app and mark its most marketable screens. It was launched with demo data (launch arguments: ${launchArgs.join(" ") || "none"}).`,
    },
    { kind: "user", text: "Start screen:", observation: payload(obs) },
  ];

  const markedNames = new Set<string>();
  const markPngs = new Map<string, Uint8Array>();
  const marks: Array<{ name: string; score: number }> = [];
  let ranked: string[] = [];
  let notes = "";
  let stoppedBecause: ExplorationResult["stoppedBecause"] = "max_steps";
  let error: string | undefined;
  let textReplies = 0;
  let actions = 0;
  let turn = 0;

  try {
    for (turn = 1; turn <= maxSteps; turn++) {
      const spent = provider.cost(usage);
      if (spent >= maxCost) {
        stoppedBecause = "budget";
        warnings.push(`stopped at $${spent.toFixed(3)} (limit $${maxCost})`);
        break;
      }
      if (turn === maxSteps) {
        history.push({ kind: "user", text: "This is your last turn: call done now with the marked screens ranked best first." });
      }
      const reply = await provider.next({ instructions: system, tools: TOOLS, history });
      modelMs += reply.ms;
      addUsage(usage, reply.usage);
      history.push({ kind: "assistant", text: reply.text, calls: reply.calls });
      emit({ kind: "turn", turn, text: reply.text, calls: reply.calls.map((c) => ({ name: c.name, args: c.args })) });
      log(
        `turn ${turn}: ${reply.calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(" + ") || `text: ${reply.text.slice(0, 120)}`}` +
          ` [${reply.ms} ms, in ${reply.usage.input} (cached ${reply.usage.cachedInput}), out ${reply.usage.output}]`,
      );

      if (reply.calls.length === 0) {
        steps.push({ turn, modelMs: reply.ms, deviceMs: 0, usage: reply.usage, text: reply.text, ...(reply.reasoning ? { reasoning: reply.reasoning } : {}), calls: [] });
        if (++textReplies > 3) {
          stoppedBecause = "text_replies";
          break;
        }
        history.push({
          kind: "user",
          text: `Answer with a tool call (${TOOLS.map((t) => t.name).join(", ")}), not text. If you have enough screens, call done.`,
        });
        continue;
      }
      textReplies = 0;

      const outputs = new Map<string, string>();
      const order = [
        ...reply.calls.filter((c) => c.name === "mark_screen"),
        ...reply.calls.filter((c) => ACTIONS.has(c.name)),
        ...reply.calls.filter((c) => c.name !== "mark_screen" && !ACTIONS.has(c.name)),
      ];
      let acted: { step?: TapStep | SwipeStep | TypeTextStep; relaunch?: boolean } | undefined;
      let finished = false;
      const turnDeviceStart = deviceMs;

      for (const call of order) {
        const output = await runCall(call);
        outputs.set(call.id, output);
        const reasonText = typeof call.args.reason === "string" ? call.args.reason : undefined;
        emit({ kind: "action", turn, name: call.name, output, ...(reasonText ? { reason: reasonText } : {}) });
      }

      async function runCall(call: ToolCall): Promise<string> {
        if (call.argsError) return `Error: ${call.argsError}`;
        const input = parseToolInput(call.name, call.args);
        if ("error" in input) return `Error: ${input.error}`;
        if (input.name === "mark_screen") return markScreen(input);
        if (input.name === "done") {
          finished = true;
          ranked = input.ranked;
          notes = input.notes;
          return "Exploration finished.";
        }
        if (acted) return "Not executed: only one action per turn. Look at the new observation first.";
        acted = {};
        actions++;
        try {
          return await timed(() => act(input));
        } catch (e) {
          return `Action failed: ${(e as Error).message.slice(0, 300)}`;
        }
      }

      function markScreen(input: Extract<ToolInput, { name: "mark_screen" }>): string {
        if (!obs.foreground) return "Error: the app is not in the foreground; nothing to mark.";
        if (marks.length >= maxScreens) return `Error: already ${maxScreens} screens marked. Call done.`;
        const name = sanitizeName(input.screenName, markedNames);
        const existing = recorder.mark({ name, why: input.why, score: input.score, state: obs.fingerprint, observationIndex: obs.index });
        if (existing) return `This screen is already marked as "${existing.name}".`;
        markedNames.add(name);
        marks.push({ name, score: input.score });
        markPngs.set(name, obs.png);
        if (out) writeFileSync(join(out, "screens", `${name}.png`), obs.png);
        emit({ kind: "mark", name, score: input.score, why: input.why, png: obs.png });
        log(`  marked "${name}" (${input.score}/10): ${input.why}`);
        return `Marked "${name}" (score ${input.score}). ${marks.length} screen(s) marked so far.`;
      }

      async function act(input: Exclude<ToolInput, { name: "mark_screen" } | { name: "done" }>): Promise<string> {
        const byRef = (ref: string) => obs.elements.find((e) => e.ref === ref);
        switch (input.name) {
          case "tap": {
            const el = byRef(input.elementId);
            if (!el) return `Error: no element ${input.elementId} in the latest observation (refs e1-e${obs.elements.length}).`;
            let step = tapStepForNode(el, obs.nodes, screen);
            if (!step) {
              const holder = nodeAt(obs.nodes, { x: el.frame.x + el.frame.w / 2, y: el.frame.y + el.frame.h / 2 });
              const target = holder ? selectorFor(holder, obs.nodes) : undefined;
              if (target) step = { action: "tap", target, fallback: normalize({ x: el.frame.x + el.frame.w / 2, y: el.frame.y + el.frame.h / 2 }, screen) };
            }
            if (!step) {
              await driver.tap({ x: el.frame.x + el.frame.w / 2, y: el.frame.y + el.frame.h / 2 });
              warnings.push(`turn ${turn}: tapped ${describe(el)}, which has no identifier or label; not recordable`);
              return `Tapped ${describe(el)}.`;
            }
            acted = { step };
            const done = await performTap(driver, step, obs.nodes, screen);
            return `Tapped ${describe(el)}${done.via === "fallback" ? " at its position" : ""}.`;
          }
          case "tap_at": {
            const point = fromGrid({ x: input.x, y: input.y }, screen);
            const node = nodeAt(obs.nodes, point);
            const target = node ? selectorFor(node, obs.nodes) : undefined;
            if (!target) {
              await driver.tap(point);
              warnings.push(`turn ${turn}: tap_at(${input.x},${input.y}) hit no labelled element; not recordable`);
              return `Tapped at (${input.x},${input.y}).`;
            }
            const step: TapStep = { action: "tap", target, fallback: normalize(point, screen) };
            acted = { step };
            await performTap(driver, step, obs.nodes, screen);
            return `Tapped at (${input.x},${input.y})${node?.label ? ` on "${node.label.slice(0, 40)}"` : ""}.`;
          }
          case "swipe": {
            let step: SwipeStep;
            if (input.from && input.to && !input.direction) {
              step = swipeStepFromPoints(fromGrid(input.from, screen), fromGrid(input.to, screen), obs.nodes, screen);
            } else {
              const el = input.elementId ? byRef(input.elementId) : undefined;
              const within = el ? selectorFor(el, obs.nodes) : undefined;
              step = { action: "swipe", direction: input.direction ?? "up", distance: input.distance ?? 0.5, ...(within ? { target: within } : {}) };
            }
            acted = { step };
            await performSwipe(driver, step, obs.nodes, screen);
            return `Swiped ${step.direction}${step.target ? ` within ${JSON.stringify(step.target)}` : ""} (distance ${step.distance}).`;
          }
          case "type_text": {
            const el = input.elementId ? byRef(input.elementId) : undefined;
            if (input.elementId && !el) return `Error: no element ${input.elementId} in the latest observation.`;
            const into = el ? selectorFor(el, obs.nodes) : undefined;
            const step: TypeTextStep = { action: "typeText", text: input.text, ...(into ? { target: into } : {}) };
            acted = { step };
            await performType(driver, step);
            return `Typed "${input.text}".`;
          }
          case "relaunch":
            acted = { relaunch: true };
            await driver.launch({ bundleId, args: launchArgs });
            return "Relaunched the app.";
        }
      }

      let observation: StepLog["observation"];
      if (acted) {
        const before = obs;
        obs = await timed(() => observe(driver, observeOptions(before.index + 1)));
        saveStepImage(obs);
        recorder.noteState(obs);
        const performed = acted as { step?: TapStep | SwipeStep | TypeTextStep; relaunch?: boolean };
        if (performed.relaunch) recorder.recordLaunch(obs.fingerprint);
        else if (performed.step) recorder.recordTransition(before.fingerprint, performed.step, obs.fingerprint);
        const changed = obs.fingerprint !== before.fingerprint;
        const actionCall = reply.calls.find((c) => ACTIONS.has(c.name) && !(outputs.get(c.id) ?? "").startsWith("Not executed"));
        if (actionCall) outputs.set(actionCall.id, `${outputs.get(actionCall.id)} ${changed ? "The screen changed." : "The screen did not change."}`);
        observation = { index: obs.index, fingerprint: obs.fingerprint, title: obs.title, changed };
      }

      const results = reply.calls.map((c) => ({ callId: c.id, name: c.name, output: outputs.get(c.id) ?? "" }));
      history.push(acted ? { kind: "results", results, observation: payload(obs) } : { kind: "results", results });
      steps.push({
        turn,
        modelMs: reply.ms,
        deviceMs: deviceMs - turnDeviceStart,
        usage: reply.usage,
        text: reply.text,
        ...(reply.reasoning ? { reasoning: reply.reasoning } : {}),
        calls: reply.calls.map((c) => ({ name: c.name, args: c.args, output: outputs.get(c.id) ?? "" })),
        ...(observation ? { observation } : {}),
      });
      if (finished) {
        stoppedBecause = "done";
        break;
      }
    }
  } catch (e) {
    stoppedBecause = "error";
    error = (e as Error).stack ?? String(e);
    log(`exploration error: ${error}`);
  }

  // Ranking: the model's order for known names, then any marked screen it left out, by score.
  const known = new Set(marks.map((m) => m.name));
  const fromModel = ranked
    .map((r) => (known.has(r) ? r : sanitizeName(r, new Set())))
    .filter((r, i, all) => known.has(r) && all.indexOf(r) === i);
  const finalRanking = [...fromModel, ...[...marks].sort((a, b) => b.score - a.score).map((m) => m.name).filter((n) => !fromModel.includes(n))];

  const flowName = `${options.appName ?? bundleId} (${provider.id})`;
  let built = recorder.build(flowName, launch);
  let verification: ExplorationResult["verification"];
  if (options.verify !== false && built.screens.length > 0 && stoppedBecause !== "error") {
    // Replay once in the exploration's own locale. A shortcut through the graph can miss hidden
    // state; screens that fail are rebuilt from their literal path and checked again.
    const verifyStarted = Date.now();
    const check = async () => {
      const replay = await timed(() => replayFlow(driver, built.flow, { screens: built.screens, log: (m) => log(`  verify ${m.trim()}`) }));
      const verified = new Set(replay.screenshots.filter((s) => s.verified).map((s) => s.name));
      return { replay, failed: built.screens.map((s) => s.name).filter((n) => !verified.has(n)) };
    };
    log("verifying the flow by replaying it");
    let { replay, failed } = await check();
    let rounds = 1;
    const literal = new Set<string>();
    if (failed.length > 0) {
      for (const name of failed) literal.add(name);
      log(`  ${failed.join(", ")} failed; rebuilding from the literal path`);
      built = recorder.build(flowName, launch, { literal });
      ({ replay, failed } = await check());
      rounds++;
    }
    if (failed.length > 0) warnings.push(`still failing after verification: ${failed.join(", ")}`);
    verification = {
      rounds,
      ms: Date.now() - verifyStarted,
      literal: [...literal],
      failed,
      screenshots: replay.screenshots.map((s) => ({ name: s.name, verified: s.verified, checks: s.checks })),
    };
  }
  warnings.push(...built.warnings);
  const result: ExplorationResult = {
    app: { bundleId, launchArgs, appName: options.appName },
    provider: { id: provider.id, model: provider.model, mode: provider.mode },
    screen,
    flow: built.flow,
    screens: built.screens,
    ...(verification ? { verification } : {}),
    ranked: finalRanking,
    notes,
    stoppedBecause,
    ...(error ? { error } : {}),
    warnings,
    turns: Math.min(turn, maxSteps),
    actions,
    usage,
    costUsd: provider.cost(usage),
    listCostUsd: provider.listCost(usage),
    timing: { totalMs: Date.now() - started, modelMs, deviceMs },
    steps,
    graph: recorder.toJSON(),
  };
  if (out) {
    writeFileSync(join(out, "exploration.json"), JSON.stringify(result, null, 2));
    writeFileSync(join(out, "flow.json"), JSON.stringify(result.flow, null, 2));
  }
  return result;
}
