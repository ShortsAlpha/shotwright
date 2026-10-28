/**
 * Locales: App Store Connect codes, writing direction, script and font stack.
 *
 * Our locales are BCP 47 tags as passed to the Simulator (`en`, `de`, `pt-BR`, `zh-Hans`, `ar`).
 * App Store Connect (and fastlane `deliver` folder names) use their own fixed list; `toAscLocale`
 * maps ours onto it.
 *
 * TODO(core): move ASC_LOCALES / toAscLocale to @shotwright/core once the web app needs them too.
 */

export interface AscLocaleSpec {
  readonly code: string;
  readonly name: string;
  /** Added to App Store Connect in 2025; older fastlane releases may not know the code yet. */
  readonly added2025?: true;
}

/** App Store Connect localizations (the folder names fastlane `deliver` accepts). */
export const ASC_LOCALES: readonly AscLocaleSpec[] = [
  { code: "ar-SA", name: "Arabic" },
  { code: "ca", name: "Catalan" },
  { code: "zh-Hans", name: "Chinese (Simplified)" },
  { code: "zh-Hant", name: "Chinese (Traditional)" },
  { code: "hr", name: "Croatian" },
  { code: "cs", name: "Czech" },
  { code: "da", name: "Danish" },
  { code: "nl-NL", name: "Dutch" },
  { code: "en-AU", name: "English (Australia)" },
  { code: "en-CA", name: "English (Canada)" },
  { code: "en-GB", name: "English (U.K.)" },
  { code: "en-US", name: "English (U.S.)" },
  { code: "fi", name: "Finnish" },
  { code: "fr-FR", name: "French" },
  { code: "fr-CA", name: "French (Canada)" },
  { code: "de-DE", name: "German" },
  { code: "el", name: "Greek" },
  { code: "he", name: "Hebrew" },
  { code: "hi", name: "Hindi" },
  { code: "hu", name: "Hungarian" },
  { code: "id", name: "Indonesian" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "ms", name: "Malay" },
  { code: "no", name: "Norwegian" },
  { code: "pl", name: "Polish" },
  { code: "pt-BR", name: "Portuguese (Brazil)" },
  { code: "pt-PT", name: "Portuguese (Portugal)" },
  { code: "ro", name: "Romanian" },
  { code: "ru", name: "Russian" },
  { code: "sk", name: "Slovak" },
  { code: "es-MX", name: "Spanish (Mexico)" },
  { code: "es-ES", name: "Spanish (Spain)" },
  { code: "sv", name: "Swedish" },
  { code: "th", name: "Thai" },
  { code: "tr", name: "Turkish" },
  { code: "uk", name: "Ukrainian" },
  { code: "vi", name: "Vietnamese" },
  { code: "bn-BD", name: "Bangla", added2025: true },
  { code: "gu-IN", name: "Gujarati", added2025: true },
  { code: "kn-IN", name: "Kannada", added2025: true },
  { code: "ml-IN", name: "Malayalam", added2025: true },
  { code: "mr-IN", name: "Marathi", added2025: true },
  { code: "or-IN", name: "Odia", added2025: true },
  { code: "pa-IN", name: "Punjabi", added2025: true },
  { code: "sl-SI", name: "Slovenian", added2025: true },
  { code: "ta-IN", name: "Tamil", added2025: true },
  { code: "te-IN", name: "Telugu", added2025: true },
  { code: "ur-PK", name: "Urdu", added2025: true },
];

const ASC_BY_LOWER = new Map(ASC_LOCALES.map((l) => [l.code.toLowerCase(), l.code]));

/** Default App Store Connect locale for a bare language subtag. */
const LANGUAGE_DEFAULT: Readonly<Record<string, string>> = {
  ar: "ar-SA",
  en: "en-US",
  de: "de-DE",
  fr: "fr-FR",
  es: "es-ES",
  pt: "pt-BR",
  nl: "nl-NL",
  zh: "zh-Hans",
  nb: "no",
  nn: "no",
  iw: "he",
  in: "id",
  bn: "bn-BD",
  gu: "gu-IN",
  kn: "kn-IN",
  ml: "ml-IN",
  mr: "mr-IN",
  or: "or-IN",
  pa: "pa-IN",
  sl: "sl-SI",
  ta: "ta-IN",
  te: "te-IN",
  ur: "ur-PK",
};

/** Regional variants App Store Connect doesn't have, mapped to the closest one it does. */
const REGION_FALLBACK: Readonly<Record<string, string>> = {
  "en-nz": "en-AU",
  "en-ie": "en-GB",
  "en-in": "en-GB",
  "en-za": "en-GB",
  "en-sg": "en-GB",
  "es-419": "es-MX",
  "es-us": "es-MX",
  "pt-ao": "pt-PT",
  "pt-mz": "pt-PT",
  "zh-cn": "zh-Hans",
  "zh-sg": "zh-Hans",
  "zh-tw": "zh-Hant",
  "zh-hk": "zh-Hant",
  "zh-mo": "zh-Hant",
};

/**
 * Maps a BCP 47 locale (`en`, `de`, `pt-BR`, `zh-Hant-TW`, `ar`) to an App Store Connect locale.
 * Throws for languages the App Store doesn't offer (e.g. `fa`).
 */
export function toAscLocale(locale: string): string {
  const tag = locale.replace(/_/g, "-").trim();
  const lower = tag.toLowerCase();
  const exact = ASC_BY_LOWER.get(lower);
  if (exact) return exact;
  const parts = lower.split("-");
  const language = parts[0]!;
  if (language === "zh") {
    if (parts.includes("hant")) return "zh-Hant";
    if (parts.includes("hans")) return "zh-Hans";
  }
  const regional = REGION_FALLBACK[parts.slice(0, 2).join("-")];
  if (regional) return regional;
  const byLanguage = ASC_BY_LOWER.get(language) ?? LANGUAGE_DEFAULT[language];
  if (byLanguage) return byLanguage;
  throw new Error(`No App Store Connect locale for "${locale}"`);
}

// --- Script, direction, fonts ------------------------------------------------

export type Script =
  | "latin"
  | "arabic"
  | "hebrew"
  | "thai"
  | "devanagari"
  | "bengali"
  | "gujarati"
  | "gurmukhi"
  | "kannada"
  | "malayalam"
  | "oriya"
  | "tamil"
  | "telugu"
  | "japanese"
  | "korean"
  | "chinese-simplified"
  | "chinese-traditional";

const SCRIPT_BY_LANGUAGE: Readonly<Record<string, Script>> = {
  ar: "arabic",
  fa: "arabic",
  ur: "arabic",
  ps: "arabic",
  sd: "arabic",
  ug: "arabic",
  ckb: "arabic",
  he: "hebrew",
  iw: "hebrew",
  yi: "hebrew",
  th: "thai",
  hi: "devanagari",
  mr: "devanagari",
  ne: "devanagari",
  bn: "bengali",
  gu: "gujarati",
  pa: "gurmukhi",
  kn: "kannada",
  ml: "malayalam",
  or: "oriya",
  ta: "tamil",
  te: "telugu",
  ja: "japanese",
  ko: "korean",
};

const RTL_LANGUAGES = new Set(["ar", "he", "iw", "fa", "ur", "ps", "sd", "ug", "yi", "dv", "ckb"]);

/** Font family (from fonts/manifest.json) that carries each script. */
const SCRIPT_FONT: Readonly<Record<Script, string | undefined>> = {
  latin: undefined,
  arabic: "Noto Sans Arabic",
  hebrew: "Noto Sans Hebrew",
  thai: "Noto Sans Thai",
  devanagari: "Noto Sans Devanagari",
  bengali: "Noto Sans Bengali",
  gujarati: "Noto Sans Gujarati",
  gurmukhi: "Noto Sans Gurmukhi",
  kannada: "Noto Sans Kannada",
  malayalam: "Noto Sans Malayalam",
  oriya: "Noto Sans Oriya",
  tamil: "Noto Sans Tamil",
  telugu: "Noto Sans Telugu",
  japanese: "Noto Sans JP",
  korean: "Noto Sans KR",
  "chinese-simplified": "Noto Sans SC",
  "chinese-traditional": "Noto Sans TC",
};

export interface LocaleTypography {
  /** Value for the `lang` attribute (drives CJK glyph variants, line breaking, hyphenation). */
  readonly lang: string;
  readonly dir: "ltr" | "rtl";
  readonly script: Script;
  /** CSS font-family list: the script's font first, then Inter for Latin, then generic. */
  readonly fontStack: string;
  /** Caption weight available for this script. */
  readonly weight: number;
  readonly lineHeight: number;
  /** In em; must be 0 for joined scripts (Arabic) and CJK. */
  readonly letterSpacing: number;
  /** Extra CSS for line breaking. */
  readonly breaking: string;
  /** Captions in this script get <wbr> at word boundaries (Chinese: no spaces, no auto-phrase). */
  readonly segmentWords: boolean;
}

export function scriptForLocale(locale: string): Script {
  const parts = locale.replace(/_/g, "-").toLowerCase().split("-");
  const language = parts[0]!;
  if (language === "zh") {
    const traditional = parts.includes("hant") || parts.some((p) => p === "tw" || p === "hk" || p === "mo");
    return traditional ? "chinese-traditional" : "chinese-simplified";
  }
  return SCRIPT_BY_LANGUAGE[language] ?? "latin";
}

export function isRtl(locale: string): boolean {
  return RTL_LANGUAGES.has(locale.replace(/_/g, "-").toLowerCase().split("-")[0]!);
}

export function localeTypography(locale: string, customFamily?: string): LocaleTypography {
  const script = scriptForLocale(locale);
  const scriptFont = SCRIPT_FONT[script];
  const families = [customFamily, scriptFont, "Inter"].filter((f): f is string => Boolean(f));
  const fontStack = [...new Set(families)].map((f) => `"${f}"`).join(", ") + ", sans-serif";
  const lang =
    script === "chinese-simplified" ? "zh-Hans" : script === "chinese-traditional" ? "zh-Hant" : locale.replace(/_/g, "-");
  const cjk = script === "japanese" || script === "korean" || script.startsWith("chinese");
  const tall = !cjk && script !== "latin";
  return {
    lang,
    dir: isRtl(locale) ? "rtl" : "ltr",
    script,
    fontStack,
    weight: script === "latin" ? 800 : 700,
    lineHeight: script === "latin" ? 1.1 : cjk ? 1.28 : script === "thai" ? 1.5 : 1.4,
    letterSpacing: script === "latin" ? -0.022 : 0,
    segmentWords: script.startsWith("chinese"),
    breaking:
      script === "japanese"
        ? "word-break: auto-phrase; line-break: strict;"
        : script === "korean"
          ? "word-break: keep-all; line-break: strict;"
          : cjk
            ? "word-break: keep-all; line-break: strict;"
            : tall
              ? "word-break: normal;"
              : "word-break: normal; hyphens: manual;",
  };
}
