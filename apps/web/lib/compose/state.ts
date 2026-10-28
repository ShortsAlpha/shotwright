/**
 * Compose as the browser sees it: settings, captions per locale, the suggested theme and the
 * rendered gallery of a run. The server builds a `ComposeView` from the run folder
 * (lib/compose/compose.ts) and keeps it in the run's job snapshot (lib/jobs/state.ts).
 *
 * No Node imports here: the session page imports this file.
 */
import type { ScreenshotSetId } from "@shotwright/core";

export type TemplateId = "caption-top" | "bleed" | "panorama";
export type FrameStyle = "device" | "none" | "full-bleed";

export const TEMPLATES: ReadonlyArray<{ readonly id: TemplateId; readonly label: string; readonly hint: string }> = [
  { id: "caption-top", label: "Caption top", hint: "Caption above the whole device" },
  { id: "bleed", label: "Bleed", hint: "A bigger device cut off by the bottom edge" },
  { id: "panorama", label: "Panorama", hint: "One background flowing across the whole set" },
];

export const FRAMES: ReadonlyArray<{ readonly id: FrameStyle; readonly label: string; readonly hint: string }> = [
  { id: "device", label: "Device", hint: "Our own device frame around the capture" },
  { id: "none", label: "Frameless", hint: "The capture with rounded corners and a shadow" },
  { id: "full-bleed", label: "Raw", hint: "The capture alone, no caption or background" },
];

/** The screenshot sets Shotwright renders, in App Store order (iPad and Duo once those captures exist). */
export const SET_ORDER: readonly ScreenshotSetId[] = ["iphone-6.3", "ipad-13", "iphone-duo-outer", "iphone-duo-inner"];

/** App Store Connect shows at most this many screenshots per set and locale. */
export const MAX_SCREENS = 10;

/** A theme the user can edit: a two-stop gradient (from = to for a solid color), caption, accent, device. */
export interface ThemeSettings {
  readonly background: { readonly from: string; readonly to: string; readonly angle: number };
  readonly captionColor: string;
  readonly accent: string;
  readonly deviceColor: "dark" | "light";
}

export interface ComposeSettings {
  readonly template: TemplateId;
  readonly frame: FrameStyle;
  /** Null: use the suggested theme (from the app icon when there is one). */
  readonly theme: ThemeSettings | null;
}

export const DEFAULT_SETTINGS: ComposeSettings = { template: "caption-top", frame: "device", theme: null };

export interface SuggestedTheme {
  /** "icon" once the app icon was read; "default" when there is none (or it was not read yet). */
  readonly source: "icon" | "default";
  /** Run file of the icon (`icon.png`). */
  readonly icon?: string;
  /** The icon's dominant colors, most common first. */
  readonly colors: readonly string[];
  readonly dark: ThemeSettings;
  readonly light: ThemeSettings;
  /** The icon was looked for (a missing icon is not looked for again). */
  readonly checked: boolean;
}

export type CaptionSource = "muse" | "judge" | "edited" | "fallback";

export interface CaptionView {
  readonly text: string;
  readonly source: CaptionSource;
  /** Rule checks that failed (too long, app name, trailing period…). */
  readonly issues?: readonly string[];
  /** For an edited caption: the one Muse wrote, which "Reset" brings back. */
  readonly original?: string;
}

export interface CaptionsView {
  /** Model of the last transcreation call, when there was one. */
  readonly model?: string;
  readonly ms?: number;
  /** locale -> screen -> caption. */
  readonly byLocale: Readonly<Record<string, Readonly<Record<string, CaptionView>>>>;
}

export type RenderStatus = "missing" | "queued" | "rendering" | "done" | "stale" | "failed";

/** One screenshot of the gallery. Paths are relative to the run folder (see artifactUrl). */
export interface RenderView {
  readonly screen: string;
  /** 1-based App Store position. */
  readonly position: number;
  readonly status: RenderStatus;
  /** The last rendered file and its thumbnail, kept while a newer version renders. */
  readonly image?: string;
  readonly thumb?: string;
  /** Changes with every render of this image (cache buster). */
  readonly version?: string;
  readonly warnings?: readonly string[];
  /** Caption font size as a share of the template's base size (1 = not shrunk). */
  readonly captionScale?: number;
  readonly error?: string;
}

export interface SetView {
  readonly id: ScreenshotSetId;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  /** Locales with captures for this set, exploration locale first. */
  readonly locales: readonly string[];
}

export interface ComposeView {
  readonly settings: ComposeSettings;
  readonly suggested: SuggestedTheme;
  readonly captions: CaptionsView;
  readonly sets: readonly SetView[];
  /** Screens in App Store order (the judge's ranking). */
  readonly screens: readonly string[];
  /** set -> locale -> screenshots in order. */
  readonly renders: Readonly<Record<string, Readonly<Record<string, readonly RenderView[]>>>>;
  readonly appName: string;
}

/** The theme a render uses: the user's, else the suggested one. */
export const effectiveTheme = (view: Pick<ComposeView, "settings" | "suggested">): ThemeSettings => view.settings.theme ?? view.suggested.dark;

export function renderCounts(view: ComposeView): { total: number; done: number; pending: number; failed: number } {
  let total = 0;
  let done = 0;
  let failed = 0;
  for (const locales of Object.values(view.renders)) {
    for (const list of Object.values(locales)) {
      for (const r of list) {
        total++;
        if (r.status === "done") done++;
        if (r.status === "failed") failed++;
      }
    }
  }
  return { total, done, pending: total - done - failed, failed };
}

/** Every screenshot is rendered and up to date, so the zip can be downloaded. */
export const exportReady = (view: ComposeView | undefined): boolean => {
  if (!view) return false;
  const counts = renderCounts(view);
  return counts.total > 0 && counts.done === counts.total;
};

// --- Caption rules ------------------------------------------------------------------

const CJK_TIGHT = new Set(["ja", "zh"]);

/** How long a caption may be in this locale: characters (graphemes, *emphasis* marks not counted) and words. */
export function captionLimit(locale: string): { chars: number; words?: number } {
  const language = locale.toLowerCase().split(/[-_]/)[0]!;
  if (CJK_TIGHT.has(language)) return { chars: 16 };
  if (language === "ko") return { chars: 18 };
  if (language === "th") return { chars: 24 };
  return { chars: 30, words: 6 };
}

const graphemes = (text: string): number => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;

/** The caption without `*emphasis*` marks, as it reads on the screenshot. */
export const plainCaption = (text: string): string => text.replace(/\*/g, "").replace(/\s+/g, " ").trim();

/** The app's name as a word of its own ("Renew", not "renewal"); substring match for CJK names. */
function namesApp(text: string, appName: string): boolean {
  const name = appName.trim();
  if (name.length < 2) return false;
  if (!/[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u.test(name)) return text.includes(name);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

/** What is wrong with a caption, in a few words each; empty when it follows the rules. */
export function captionIssues(text: string, locale: string, appName?: string): string[] {
  const plain = plainCaption(text);
  const issues: string[] = [];
  if (!plain) return ["empty"];
  const limit = captionLimit(locale);
  const length = graphemes(plain);
  if (length > limit.chars) issues.push(`${length} characters (max ${limit.chars})`);
  if (limit.words) {
    const words = plain.split(" ").filter(Boolean).length;
    if (words > limit.words) issues.push(`${words} words (max ${limit.words})`);
  }
  if (/[.。．]$/.test(plain) && !/\.\.\.$|…$/.test(plain)) issues.push("ends with a period");
  if (appName && namesApp(plain, appName)) issues.push("names the app");
  if ((text.match(/\*/g)?.length ?? 0) % 2 === 1) issues.push("unbalanced *");
  return issues;
}
