/**
 * Screen judge: sends the marked screenshots to a vision model (Muse Spark Open on Baseten by
 * default) to rank them for the App Store and draft a short English caption for each.
 */
import { MuseClient, MuseError, jsonSchemaFormat, type ChatContentPart } from "@shotwright/muse";
import { downscale } from "./observe.ts";
import { SPARK_OPEN_MODEL, basetenClient } from "./providers/chat.ts";
import { priceOf } from "./providers/pricing.ts";
import { parseJsonObject } from "./json.ts";
import type { Usage } from "./providers/types.ts";

export interface JudgeScreen {
  readonly name: string;
  /** Full-resolution PNG. */
  readonly png: Uint8Array;
  /** The explorer's reason for marking it. */
  readonly why?: string;
}

export interface JudgedScreen {
  readonly name: string;
  readonly rank: number;
  readonly score: number;
  readonly caption: string;
  readonly reason: string;
}

export interface JudgeResult {
  readonly model: string;
  readonly ranking: JudgedScreen[];
  readonly notes: string;
  readonly usage: Usage;
  readonly ms: number;
  /** List price; Spark Open on Baseten is free for us during the hackathon. */
  readonly listCostUsd: number;
  readonly structuredOutput: boolean;
  readonly reasoning?: string;
}

export interface JudgeOptions {
  readonly screens: readonly JudgeScreen[];
  readonly appName?: string;
  readonly appDescription?: string;
  readonly client?: MuseClient;
  readonly model?: string;
  /** Width of the images sent, in pixels. Default 440 (point size on the iPhone 6.9"). */
  readonly imageWidth?: number;
}

const SCHEMA = {
  type: "object",
  properties: {
    ranking: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          score: { type: "integer", minimum: 1, maximum: 10 },
          caption: { type: "string" },
          reason: { type: "string" },
        },
        required: ["name", "score", "caption", "reason"],
        additionalProperties: false,
      },
    },
    notes: { type: "string" },
  },
  required: ["ranking", "notes"],
  additionalProperties: false,
};

export async function judgeScreens(options: JudgeOptions): Promise<JudgeResult> {
  const client = options.client ?? basetenClient();
  const model = options.model ?? SPARK_OPEN_MODEL;
  const width = options.imageWidth ?? 440;
  const content: ChatContentPart[] = [
    {
      type: "text",
      text:
        `These are ${options.screens.length} candidate App Store screenshots of the iOS app${options.appName ? ` "${options.appName}"` : ""}` +
        `${options.appDescription ? ` (${options.appDescription})` : ""}. Each image follows its name.\n\n` +
        "1. Rank all of them for the App Store product page, best first. The first three matter most: they appear in search results, so they must show the app's core value at a glance. Prefer screens with rich, realistic content and visual variety across the set; penalize empty states, settings, legal pages and near-duplicates.\n" +
        "2. For each, write one English caption for the marketing banner above the screenshot: a benefit-led headline of at most 6 words (about 30 characters), sentence case, no app name, no quotes, no trailing period.\n" +
        "3. Give each a score from 1 to 10 and a one-sentence reason.\n\n" +
        'Answer with JSON only: {"ranking": [{"name", "score", "caption", "reason"}], "notes": "<one or two sentences about the set as a whole>"}. Use the names exactly as given.',
    },
  ];
  for (const screen of options.screens) {
    const image = await downscale(screen.png, width, Math.round((width * 2868) / 1320), 75).catch(() => screen.png);
    content.push({ type: "text", text: `Screen "${screen.name}"${screen.why ? ` (explorer's note: ${screen.why})` : ""}:` });
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from(image).toString("base64")}` } });
  }

  const started = Date.now();
  const request = { model, messages: [{ role: "user" as const, content }], max_completion_tokens: 8_000 };
  let structuredOutput = true;
  let result;
  try {
    result = await client.chat({ ...request, response_format: jsonSchemaFormat("screen_ranking", SCHEMA) });
  } catch (error) {
    if (!(error instanceof MuseError) || error.status !== 400) throw error;
    structuredOutput = false;
    result = await client.chat(request);
  }
  const parsed = parseJsonObject(result.text) as { ranking?: Array<Partial<JudgedScreen>>; notes?: string } | undefined;
  if (!parsed?.ranking) throw new Error(`judge returned no ranking: ${result.text.slice(0, 500)}`);
  const known = new Set(options.screens.map((s) => s.name));
  const ranking = parsed.ranking
    .filter((r): r is Partial<JudgedScreen> & { name: string } => typeof r.name === "string" && known.has(r.name))
    .map((r, i) => ({
      name: r.name,
      rank: i + 1,
      score: typeof r.score === "number" ? r.score : 0,
      caption: String(r.caption ?? "").trim(),
      reason: String(r.reason ?? "").trim(),
    }));
  const u = result.usage;
  const usage: Usage = {
    input: u?.prompt_tokens ?? 0,
    cachedInput: u?.prompt_tokens_details?.cached_tokens ?? 0,
    output: u?.completion_tokens ?? 0,
    reasoning: u?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
  const reasoning = (result.message as { reasoning_content?: string }).reasoning_content;
  return {
    model,
    ranking,
    notes: parsed.notes ?? "",
    usage,
    ms: Date.now() - started,
    listCostUsd: priceOf(model, usage),
    structuredOutput,
    ...(reasoning ? { reasoning } : {}),
  };
}
