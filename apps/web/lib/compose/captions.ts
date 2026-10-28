/**
 * Caption transcreation: one Muse Spark Open call per run writes a caption for every screen in every
 * locale, natively for that market (not a word-for-word translation of the judge's English draft).
 * The answer is checked against the caption rules (state.ts `captionIssues`); captions that break
 * them or are missing get one repair call. What still fails keeps its issues for the UI.
 */
import { SPARK_OPEN_MODEL, basetenClient } from "@shotwright/explorer";
import { MuseError, jsonSchemaFormat, type ChatMessage, type MuseClient } from "@shotwright/muse";
import { abortable } from "../jobs/abort.ts";
import { localeName } from "../jobs/state.ts";
import { captionIssues, captionLimit, plainCaption } from "./state.ts";

export interface CaptionScreen {
  readonly name: string;
  /** The judge's English caption (may be empty). */
  readonly draft: string;
  /** What the screen shows (explorer's note, judge's reason). */
  readonly shows: string;
}

export interface CaptionRequest {
  readonly appName: string;
  readonly description: string;
  readonly screens: readonly CaptionScreen[];
  readonly locales: readonly string[];
}

export interface CaptionResult {
  readonly model: string;
  readonly ms: number;
  /** Model calls made (1, or 2 with a repair). */
  readonly calls: number;
  readonly usage: { readonly input: number; readonly output: number; readonly reasoning: number };
  /** locale -> screen -> caption (cleaned). Missing entries mean the model gave none. */
  readonly captions: Record<string, Record<string, string>>;
  readonly structuredOutput: boolean;
}

/** Writes captions; the real one calls Spark Open, the fake one (SHOTWRIGHT_FAKE_MODELS=1) uses a table. */
export type CaptionWriter = (request: CaptionRequest, signal?: AbortSignal) => Promise<CaptionResult>;

/** Full market names help the model pick the right register ("de" alone could be Austria or Switzerland). */
const MARKETS: Record<string, string> = {
  en: "English, United States",
  de: "German, Germany",
  ja: "Japanese, Japan",
  fr: "French, France",
  es: "Spanish, Spain",
  it: "Italian, Italy",
  pt: "Portuguese, Brazil",
  ko: "Korean, South Korea",
  "zh-Hans": "Simplified Chinese, China mainland",
  tr: "Turkish, Türkiye",
  nl: "Dutch, Netherlands",
  ar: "Arabic, Saudi Arabia",
};

const market = (locale: string) => MARKETS[locale] ?? localeName(locale);

function limitText(locale: string): string {
  const limit = captionLimit(locale);
  return limit.words ? `at most ${limit.chars} characters and ${limit.words} words` : `at most ${limit.chars} characters`;
}

const SYSTEM =
  "You are a senior App Store localization copywriter. You transcreate the marketing captions shown above App Store screenshots: " +
  "for every market you write the caption a native copywriter there would write, keeping the benefit of the English draft but never translating it word for word.";

export function captionPrompt(request: CaptionRequest): string {
  const screens = request.screens
    .map((s, i) => `${i + 1}. ${s.name}\n   English draft: ${s.draft ? `"${s.draft}"` : "(none, write one)"}\n   The screen shows: ${s.shows || "(no notes)"}`)
    .join("\n");
  const locales = request.locales.map((l) => `- ${l}: ${market(l)}, ${limitText(l)}`).join("\n");
  return [
    `App: ${request.appName}${request.description ? `, ${request.description}` : ""}.`,
    "",
    `Screenshots in App Store order (the first three appear in search results):`,
    screens,
    "",
    "Write one caption per screenshot for each locale:",
    locales,
    "",
    "Rules:",
    "- Benefit-led: say what the user gets, not what the screen is.",
    "- Native: idiomatic App Store copy for that market. Rephrase freely; keep the meaning.",
    "- Use the words local apps use for product concepts, not anglicisms or literal translations (a free trial is \"Probeabo\" or \"Testphase\" in German, \"無料体験\" in Japanese).",
    "- Short: stay within the limit given for the locale (count characters, spaces included).",
    "- Grammatical, complete phrases: never drop particles or articles to save characters (Japanese keeps を, が, に); pick shorter words instead. No slang or clipped words (\"subs\").",
    "- Sentence case: capitalize only the first word and words the language always capitalizes (German nouns, proper names).",
    "- No app name, no quotes, no emoji, no trailing period (no 。 either).",
    "- Japanese and Chinese: no spaces between words. Arabic and Hebrew: write in the script itself, right to left.",
    "- Every caption in one locale must be different from the others.",
    "- en: keep the English draft if it follows these rules; otherwise improve it.",
    "- In every caption, wrap the key benefit (one to four words, e.g. *at a glance*) in *asterisks*; it is drawn in the accent color. Exactly one marked run per caption, never the whole caption.",
    "",
    'Answer with JSON only: {"captions":[{"screen":"<name>","locale":"<code>","text":"<caption>"}]}, one entry for every screenshot in every locale, names and codes exactly as given.',
  ].join("\n");
}

function schema(request: CaptionRequest) {
  return {
    type: "object",
    properties: {
      captions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            screen: { type: "string", enum: request.screens.map((s) => s.name) },
            locale: { type: "string", enum: [...request.locales] },
            text: { type: "string" },
          },
          required: ["screen", "locale", "text"],
          additionalProperties: false,
        },
      },
    },
    required: ["captions"],
    additionalProperties: false,
  };
}

/** Quotes, trailing periods, doubled spaces and unbalanced asterisks removed. */
export function cleanCaption(text: string): string {
  let t = text.normalize("NFC").replace(/\s+/g, " ").trim();
  t = t.replace(/^["'“”„«»「『]+|["'“”«»」』]+$/g, "").trim();
  t = t.replace(/(?<!\.)[.。．]+$/, "").trim();
  // Unbalanced marks, or the whole caption marked (all accent color), read worse than none.
  if ((t.match(/\*/g)?.length ?? 0) % 2 === 1 || /^\*[^*]+\*$/.test(t)) t = t.replace(/\*/g, "");
  return t;
}

/** Parses the first JSON object in a reply (bare, fenced, or embedded in text). */
function parseJson(text: string): unknown {
  const candidates = [text.trim(), /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? "", text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c);
    } catch {
      // next
    }
  }
  return undefined;
}

function collect(parsed: unknown, request: CaptionRequest, into: Record<string, Record<string, string>>): void {
  const list = (parsed as { captions?: unknown })?.captions;
  if (!Array.isArray(list)) return;
  const screens = new Set(request.screens.map((s) => s.name));
  const locales = new Set(request.locales);
  for (const item of list as Array<Record<string, unknown>>) {
    const { screen, locale, text } = item ?? {};
    if (typeof screen !== "string" || typeof locale !== "string" || typeof text !== "string") continue;
    if (!screens.has(screen) || !locales.has(locale)) continue;
    const cleaned = cleanCaption(text);
    if (cleaned) (into[locale] ??= {})[screen] = cleaned;
  }
}

/** Captions that are missing or break a rule, as "locale/screen: problem" lines. */
export function captionProblems(request: CaptionRequest, captions: Record<string, Record<string, string>>): Array<{ locale: string; screen: string; problem: string }> {
  const out: Array<{ locale: string; screen: string; problem: string }> = [];
  for (const locale of request.locales) {
    const seen = new Map<string, string>();
    for (const screen of request.screens) {
      const text = captions[locale]?.[screen.name];
      if (!text) {
        out.push({ locale, screen: screen.name, problem: "missing" });
        continue;
      }
      const issues = captionIssues(text, locale, request.appName);
      const twin = seen.get(plainCaption(text).toLowerCase());
      if (twin) issues.push(`same as ${twin}`);
      seen.set(plainCaption(text).toLowerCase(), screen.name);
      if (issues.length) out.push({ locale, screen: screen.name, problem: `"${text}": ${issues.join(", ")}` });
    }
  }
  return out;
}

export interface MuseCaptionOptions {
  readonly client?: MuseClient;
  readonly model?: string;
  readonly reasoningEffort?: "low" | "medium" | "high";
  /** Called with the first answer's problems before the repair call (diagnostics). */
  readonly onProblems?: (problems: ReturnType<typeof captionProblems>) => void;
}

export function museCaptionWriter(options: MuseCaptionOptions = {}): CaptionWriter {
  const { client, model = SPARK_OPEN_MODEL, reasoningEffort } = options;
  return async (request, signal) => {
    const api = client ?? basetenClient();
    const started = Date.now();
    const usage = { input: 0, output: 0, reasoning: 0 };
    let structuredOutput = true;
    let calls = 0;
    const send = async (messages: ChatMessage[]) => {
      calls++;
      const base = { model, messages, max_completion_tokens: 12_000, ...(reasoningEffort && { reasoning_effort: reasoningEffort }) };
      let result;
      try {
        result = await abortable(signal ?? new AbortController().signal, api.chat(structuredOutput ? { ...base, response_format: jsonSchemaFormat("captions", schema(request)) } : base));
      } catch (error) {
        if (!(error instanceof MuseError) || error.status !== 400 || !structuredOutput) throw error;
        structuredOutput = false;
        result = await abortable(signal ?? new AbortController().signal, api.chat(base));
      }
      usage.input += result.usage?.prompt_tokens ?? 0;
      usage.output += result.usage?.completion_tokens ?? 0;
      usage.reasoning += result.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      return result.text;
    };

    const captions: Record<string, Record<string, string>> = {};
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM },
      { role: "user", content: captionPrompt(request) },
    ];
    const first = await send(messages);
    const parsed = parseJson(first);
    if (parsed === undefined) throw new Error(`The caption model returned no JSON: ${first.slice(0, 300)}`);
    collect(parsed, request, captions);

    // One repair round for what is missing or breaks a rule.
    const problems = captionProblems(request, captions);
    options.onProblems?.(problems);
    if (problems.length > 0) {
      const repair = [
        "Some captions are missing or break the rules:",
        ...problems.map((p) => `- ${p.locale} / ${p.screen}: ${p.problem}`),
        "",
        "Write new captions for exactly these, following every rule (mind the length limit). Same JSON format.",
      ].join("\n");
      const second = await send([...messages, { role: "assistant", content: first }, { role: "user", content: repair }]);
      const fixed: Record<string, Record<string, string>> = {};
      collect(parseJson(second), request, fixed);
      for (const p of problems) {
        const better = fixed[p.locale]?.[p.screen];
        const current = captions[p.locale]?.[p.screen];
        // Keep the new caption unless it is worse (still breaking more rules than the old one).
        if (better && (!current || captionIssues(better, p.locale, request.appName).length <= captionIssues(current, p.locale, request.appName).length)) {
          (captions[p.locale] ??= {})[p.screen] = better;
        }
      }
    }
    return { model, ms: Date.now() - started, calls, usage, captions, structuredOutput };
  };
}

// --- Fake ---------------------------------------------------------------------------

/** The fake app's screens (`connect --fake`) in en/de/ja, written as a copywriter would. */
const FAKE: Record<string, Record<string, string>> = {
  en: {
    "home-overview": "All your renewals *at a glance*",
    "calendar-month": "Never miss a *due date*",
    "insights-spend": "Know where your *money goes*",
    "subscription-detail": "Every charge in detail",
    "disney-detail": "Catch trials *before they bill*",
    "start-screen": "Everything in one place",
  },
  de: {
    "home-overview": "Alle Abos *auf einen Blick*",
    "calendar-month": "Keine Abbuchung verpassen",
    "insights-spend": "Sieh, wohin dein *Geld fließt*",
    "subscription-detail": "Jede Zahlung im Detail",
    "disney-detail": "Probeabos *rechtzeitig* kündigen",
    "start-screen": "Alles an einem Ort",
  },
  ja: {
    "home-overview": "更新日を*ひと目で*",
    "calendar-month": "支払日をもう忘れない",
    "insights-spend": "*出費の内訳*がわかる",
    "subscription-detail": "請求をくわしく確認",
    "disney-detail": "無料期間の*課金前*に通知",
    "start-screen": "すべてをひとつに",
  },
};

export const fakeCaptionWriter: CaptionWriter = async (request, signal) => {
  await abortable(signal ?? new AbortController().signal, new Promise((resolve) => setTimeout(resolve, 1200)));
  const captions: Record<string, Record<string, string>> = {};
  for (const locale of request.locales) {
    for (const screen of request.screens) {
      const text = FAKE[locale]?.[screen.name] ?? (locale === "en" ? screen.draft : `${screen.draft || screen.name} (${locale})`);
      (captions[locale] ??= {})[screen.name] = cleanCaption(text);
    }
  }
  return { model: "stub captions (SHOTWRIGHT_FAKE_MODELS=1)", ms: 1200, calls: 1, usage: { input: 0, output: 0, reasoning: 0 }, captions, structuredOutput: true };
};
