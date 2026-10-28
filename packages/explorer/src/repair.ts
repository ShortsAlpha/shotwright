/**
 * Step repair for replay: when a tap's target cannot be found, or a screenshot step is not on
 * the expected screen, a model looks at the current screen (the same observation the explorer
 * uses: screenshot + element list), the recorded step and, when available, the screenshot the
 * step was recorded on with the target outlined, and picks one action. The replayer runs it and
 * verifies the step's expected outcome. At most `maxAttemptsPerStep` model calls per step and
 * `maxCostUsd` per replay.
 */
import type { DeviceDriver, ElementSelector, NormalizedPoint, NormalizedRect, Point, ScreenInfo, ScreenshotStep, TapStep } from "@shotwright/core";
import sharp from "sharp";
import { performSwipe, selectorFor } from "./actions.ts";
import { center, fromGrid, observe, type Observation, type ObservedElement } from "./observe.ts";
import { createProvider } from "./providers/index.ts";
import { addUsage, emptyUsage, type ExplorerProvider, type HistoryItem, type Usage } from "./providers/types.ts";
import { TOOLS, parseToolInput, type ToolSpec } from "./tools.ts";

export interface RepairOptions {
  /**
   * The model: an ExplorerProvider, or "spark" (Muse Spark 1.3, the default; fast) or "open"
   * (Muse Spark Open on Baseten; free during the hackathon, about 2x slower).
   */
  readonly provider?: ExplorerProvider | "spark" | "open";
  /** Model calls per broken step. Default 2. */
  readonly maxAttemptsPerStep?: number;
  /** No more repairs once this replay's repairs cost this much (USD). Default 0.10. */
  readonly maxCostUsd?: number;
  /**
   * The screenshot of the screen a step was recorded on, by flow step index (the exploration's
   * steps/NNN.jpg; see ExplorationResult.stepSources). JPEG or PNG at any size.
   */
  readonly referenceImage?: (stepIndex: number) => Uint8Array | undefined;
}

export interface RepairAttempt {
  /** e.g. `tap e7`, `tap_at (500,370)`, `swipe up`, `give_up`, `no tool call`. */
  readonly action: string;
  readonly element?: { readonly type: string; readonly label?: string; readonly id?: string };
  readonly point?: Point;
  readonly reason?: string;
  readonly verified: boolean;
  readonly modelMs: number;
  readonly usage: Usage;
  readonly costUsd: number;
}

export interface RepairRecord {
  /** Flow step index. */
  readonly stepIndex: number;
  /** "tap": the target was not found; "screen": a screenshot step was not on the expected screen. */
  readonly kind: "tap" | "screen";
  readonly ok: boolean;
  readonly model: string;
  readonly attempts: RepairAttempt[];
  /** Whether any attempt acted on the device (tap or swipe). */
  readonly acted: boolean;
  readonly costUsd: number;
  /** List price (Spark Open is free for us). */
  readonly listCostUsd: number;
  readonly ms: number;
  /** The selector of the element that worked, in this locale (to patch the flow). */
  readonly chosen?: ElementSelector;
  readonly note?: string;
}

export interface RepairContext {
  readonly driver: DeviceDriver;
  readonly screen: ScreenInfo;
  readonly bundleId: () => string;
  /** e.g. "de (DE), left to right". */
  readonly localeText: string;
  readonly rtl: boolean;
  readonly log: (message: string) => void;
}

/** Checks the outcome after a repair action; `before` is the observation the action was chosen on. */
export type RepairCheck = (before: Observation) => Promise<boolean>;

const GIVE_UP: ToolSpec = {
  name: "give_up",
  description: "The element (or a way to the expected screen) is clearly not on the current screen.",
  parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
};

const REPAIR_TOOLS: readonly ToolSpec[] = [...TOOLS.filter((t) => t.name === "tap" || t.name === "tap_at" || t.name === "swipe"), GIVE_UP];

const INSTRUCTIONS = [
  "You repair one step of a recorded UI flow for an iOS app. The flow was recorded once (in one language, on one device) and is replayed in other languages and on other devices; this step could not be matched automatically.",
  "",
  "Each observation has a screenshot and the visible accessibility elements, one per line:",
  '  e7 button "Add" #home.add (912,64)',
  "= ref, type, label, #accessibility identifier (if any), centre on a 0-1000 grid (x from the left, y from the top). Only use refs from the latest observation.",
  "",
  "Call exactly one tool per turn:",
  "- tap the element on the current screen that does the same thing as the recorded one: the same control, segment, tab, row or button. Its label may be translated, prices and dates are formatted for the locale, and right-to-left languages mirror the layout (what was on the left is on the right).",
  "- tap_at only when the element is missing from the list but visible in the screenshot.",
  "- swipe when it is probably just scrolled out of view.",
  "- give_up when it is clearly not reachable from this screen.",
  "Never delete data, buy anything or leave the app.",
].join("\n");

function describeSelector(selector: ElementSelector | undefined, fallback?: NormalizedPoint): string {
  if (!selector) return fallback ? `the point (${Math.round(fallback.x * 1000)},${Math.round(fallback.y * 1000)})` : "an unknown element";
  const parts: string[] = [selector.type ?? "element"];
  if (selector.label) parts.push(`"${selector.label}"`);
  if (selector.id) parts.push(`#${selector.id}`);
  if (selector.index !== undefined) parts.push(`(number ${selector.index + 1} of its kind in its container)`);
  const at = selector.frame
    ? { x: (selector.frame.x + selector.frame.w / 2) * 1000, y: (selector.frame.y + selector.frame.h / 2) * 1000 }
    : fallback
      ? { x: fallback.x * 1000, y: fallback.y * 1000 }
      : undefined;
  if (at) parts.push(`at (${Math.round(at.x)},${Math.round(at.y)}) when recorded`);
  return parts.join(" ");
}

/** Outlines the recorded target on the reference screenshot (red box, or a ring around a point). */
export async function outlineTarget(image: Uint8Array, rect?: NormalizedRect, point?: NormalizedPoint): Promise<Uint8Array> {
  if (!rect && !point) return image;
  const meta = await sharp(image).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) return image;
  const stroke = Math.max(3, Math.round(w / 130));
  const shape = rect
    ? `<rect x="${rect.x * w - stroke}" y="${rect.y * h - stroke}" width="${rect.w * w + 2 * stroke}" height="${rect.h * h + 2 * stroke}" rx="${stroke * 2}" fill="none" stroke="#ff1f1f" stroke-width="${stroke}"/>`
    : `<circle cx="${point!.x * w}" cy="${point!.y * h}" r="${w / 18}" fill="none" stroke="#ff1f1f" stroke-width="${stroke}"/>`;
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${shape}</svg>`);
  const out = await sharp(image).composite([{ input: svg }]).jpeg({ quality: 75 }).toBuffer();
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/** Point-size JPEG for the model. */
async function referenceJpeg(image: Uint8Array, screen: ScreenInfo): Promise<Uint8Array> {
  const meta = await sharp(image).metadata();
  const width = Math.round(screen.width);
  if ((meta.width ?? 0) <= width * 1.1 && meta.format === "jpeg") return image;
  const height = meta.width && meta.height ? Math.round((width * meta.height) / meta.width) : Math.round(screen.height);
  const out = await sharp(image).resize(width, height, { fit: "fill" }).jpeg({ quality: 72 }).toBuffer();
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

export class StepRepairer {
  readonly records: RepairRecord[] = [];
  readonly #options: RepairOptions;
  readonly #ctx: RepairContext;
  #provider: ExplorerProvider | undefined;
  #spent = 0;
  #listSpent = 0;
  #observations = 0;

  constructor(options: RepairOptions, ctx: RepairContext) {
    this.#options = options;
    this.#ctx = ctx;
  }

  get costUsd(): number {
    return this.#spent;
  }

  get listCostUsd(): number {
    return this.#listSpent;
  }

  get maxCostUsd(): number {
    return this.#options.maxCostUsd ?? 0.1;
  }

  /** False once the cost cap is reached. */
  get available(): boolean {
    return this.#spent < this.maxCostUsd;
  }

  #model(): ExplorerProvider {
    if (this.#provider) return this.#provider;
    const p = this.#options.provider ?? "spark";
    this.#provider =
      typeof p !== "string"
        ? p
        : p === "open"
          ? createProvider("open", { reasoningEffort: "low" })
          : createProvider("spark", { reasoningEffort: "low", promptCacheKey: "shotwright-repair-v1" });
    return this.#provider;
  }

  async #reference(stepIndex: number, rect?: NormalizedRect, point?: NormalizedPoint): Promise<Uint8Array | undefined> {
    const raw = this.#options.referenceImage?.(stepIndex);
    if (!raw) return undefined;
    try {
      return await outlineTarget(await referenceJpeg(raw, this.#ctx.screen), rect, point);
    } catch (error) {
      this.#ctx.log(`    repair: reference image for step ${stepIndex} unusable: ${(error as Error).message}`);
      return undefined;
    }
  }

  /** A tap whose target was not found. `expectation` says what should happen after the tap. */
  async repairTap(stepIndex: number, step: TapStep, expectation: string, check: RepairCheck): Promise<RepairRecord> {
    const reference = await this.#reference(stepIndex, step.target?.frame, step.target?.frame ? undefined : (step.fallback ?? step.point));
    const task = [
      `Recorded step: tap ${describeSelector(step.target, step.fallback ?? step.point)}.`,
      `Replaying in: ${this.#ctx.localeText}. The recorded selector matched nothing on the current screen.`,
      `After this tap the flow expects: ${expectation}.`,
      reference
        ? "The first image is the screen when the step was recorded, with the tapped element outlined in red. The second image is the current screen."
        : "No recorded screenshot is available; the image is the current screen.",
      "Tap the element on the current screen that does the same thing.",
    ].join("\n");
    return this.#run("tap", stepIndex, task, reference, check);
  }

  /** A screenshot step that is not on the expected screen. */
  async repairScreen(
    stepIndex: number,
    step: ScreenshotStep,
    expected: { title?: string; ids: readonly string[]; problems: readonly string[] },
    check: RepairCheck,
  ): Promise<RepairRecord> {
    const reference = await this.#reference(stepIndex);
    const task = [
      `The flow should now show the screen "${step.name}"${expected.title ? ` (title "${expected.title}" when recorded)` : ""}${expected.ids.length ? `, which has the accessibility identifiers ${expected.ids.map((i) => `#${i}`).join(", ")}` : ""}.`,
      `It does not: ${expected.problems.join("; ")}.`,
      `Replaying in: ${this.#ctx.localeText}.`,
      reference
        ? "The first image is the expected screen as recorded. The second image is the current screen."
        : "No recorded screenshot is available; the image is the current screen.",
      "Choose one action that gets from the current screen to the expected one: the matching tab, segment, row or button, or the back button.",
    ].join("\n");
    return this.#run("screen", stepIndex, task, reference, check);
  }

  async #run(kind: "tap" | "screen", stepIndex: number, task: string, reference: Uint8Array | undefined, check: RepairCheck): Promise<RepairRecord> {
    const { driver, screen, log } = this.#ctx;
    const started = Date.now();
    const provider = this.#model();
    const maxAttempts = this.#options.maxAttemptsPerStep ?? 2;
    const attempts: RepairAttempt[] = [];
    let cost = 0;
    let listCost = 0;
    let acted = false;
    let ok = false;
    let chosen: ElementSelector | undefined;
    let note: string | undefined;
    const observeNow = () => observe(driver, { bundleId: this.#ctx.bundleId(), screen, index: this.#observations++ });
    let obs = await observeNow();
    const history: HistoryItem[] = [{ kind: "user", text: task, observation: { index: obs.index, text: obs.text, summary: obs.summary, image: obs.image }, ...(reference ? { images: [reference] } : {}) }];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!this.available) {
        note = `repair budget of $${this.maxCostUsd.toFixed(2)} reached`;
        break;
      }
      let reply: Awaited<ReturnType<ExplorerProvider["next"]>>;
      try {
        reply = await provider.next({ instructions: INSTRUCTIONS, tools: REPAIR_TOOLS, history });
      } catch (error) {
        note = `model call failed: ${(error as Error).message.slice(0, 200)}`;
        log(`    repair step ${stepIndex}: ${note}`);
        break;
      }
      const usage = emptyUsage();
      addUsage(usage, reply.usage);
      const callCost = provider.cost(usage);
      const callList = provider.listCost(usage);
      cost += callCost;
      listCost += callList;
      this.#spent += callCost;
      this.#listSpent += callList;
      history.push({ kind: "assistant", text: reply.text, calls: reply.calls });
      const base = { modelMs: reply.ms, usage, costUsd: callCost };
      const call = reply.calls.find((c) => c.name !== "give_up") ?? reply.calls[0];
      if (!call) {
        attempts.push({ action: "no tool call", ...(reply.text ? { reason: reply.text.slice(0, 200) } : {}), verified: false, ...base });
        history.push({ kind: "user", text: "Answer with a tool call: tap, tap_at, swipe or give_up." });
        continue;
      }
      const reason = typeof call.args.reason === "string" ? call.args.reason.slice(0, 300) : undefined;
      if (call.name === "give_up") {
        attempts.push({ action: "give_up", ...(reason ? { reason } : {}), verified: false, ...base });
        log(`    repair step ${stepIndex}: model gave up${reason ? ` (${reason})` : ""}`);
        break;
      }
      const input = call.argsError ? { error: call.argsError } : parseToolInput(call.name, call.args);
      let output: string;
      let element: ObservedElement | undefined;
      let point: Point | undefined;
      let action = call.name;
      if ("error" in input) {
        output = `Error: ${input.error}`;
      } else if (input.name === "tap") {
        element = obs.elements.find((e) => e.ref === input.elementId);
        if (!element) output = `Error: no element ${input.elementId} in the latest observation.`;
        else {
          point = center(element.frame);
          action = `tap ${element.ref}`;
          await driver.tap({ x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 });
          acted = true;
          output = `Tapped ${element.ref}.`;
        }
      } else if (input.name === "tap_at") {
        point = fromGrid({ x: input.x, y: input.y }, screen);
        action = `tap_at (${input.x},${input.y})`;
        await driver.tap({ x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 });
        acted = true;
        output = `Tapped at (${input.x},${input.y}).`;
      } else if (input.name === "swipe") {
        const direction = input.direction ?? "up";
        action = `swipe ${direction}`;
        await performSwipe(driver, { action: "swipe", direction, distance: input.distance ?? 0.5 }, obs.nodes, screen);
        acted = true;
        output = `Swiped ${direction}.`;
      } else {
        output = `Error: ${call.name} is not available here; use tap, tap_at, swipe or give_up.`;
      }
      const before = obs;
      const verified = output.startsWith("Error") ? false : await check(before);
      attempts.push({
        action,
        ...(element ? { element: { type: element.type, ...(element.label ? { label: element.label } : {}), ...(element.identifier ? { id: element.identifier } : {}) } } : {}),
        ...(point ? { point: { x: Math.round(point.x), y: Math.round(point.y) } } : {}),
        ...(reason ? { reason } : {}),
        verified,
        ...base,
      });
      log(`    repair step ${stepIndex} attempt ${attempt}: ${action}${element?.label ? ` "${element.label.slice(0, 50)}"` : ""} -> ${verified ? "verified" : "not verified"} (${reply.ms} ms, $${callCost.toFixed(4)})`);
      if (verified) {
        ok = true;
        if (element) chosen = selectorFor(element, before.nodes, screen);
        break;
      }
      if (attempt < maxAttempts) {
        obs = await observeNow();
        history.push({
          kind: "results",
          results: reply.calls.map((c) => ({ callId: c.id, name: c.name, output: c === call ? `${output} The expected result did not appear.` : "Not executed." })),
          observation: { index: obs.index, text: obs.text, summary: obs.summary, image: obs.image },
        });
      }
    }
    const record: RepairRecord = {
      stepIndex,
      kind,
      ok,
      model: provider.model,
      attempts,
      acted,
      costUsd: cost,
      listCostUsd: listCost,
      ms: Date.now() - started,
      ...(chosen ? { chosen } : {}),
      ...(note ? { note } : {}),
    };
    this.records.push(record);
    return record;
  }
}
