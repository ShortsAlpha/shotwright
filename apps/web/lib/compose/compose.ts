/**
 * Compose a run's final App Store screenshots from its replayed captures, and export them.
 *
 *   const summary = await composeRun(runDir, { settings, captionWriter, icon });   // captions, theme, renders
 *   const view = await loadCompose(runDir);                                          // what the page shows
 *   const zip = await exportZip(runDir);                                             // fastlane deliver layout
 *
 * Everything lives in the run folder (lib/jobs/artifacts.ts):
 *
 *   captions.json        locale -> screen -> { text, source }, plus the model calls made
 *   icon.png, theme.json the app icon and the themes derived from it (or the default theme)
 *   compose.json         settings (template, frame, theme) and one record per rendered image
 *   renders/<set>/<locale>/<nn>_<screen>.png           exact App Store size, no alpha
 *   renders/<set>/<locale>/thumbs/<nn>_<screen>.jpg    for the gallery
 *   export/<app>-screenshots.zip                       screenshots/<asc-locale>/… + README.txt
 *
 * Each render record keeps a hash of everything that went into the image (set, template, frame,
 * theme, caption, position, capture file), so composing again only renders what changed: editing
 * one caption re-renders one image. Runs of one folder are serialized (`withRunLock`).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SCREENSHOT_SETS, type ScreenshotSetId } from "@shotwright/core";
import { downscale } from "@shotwright/explorer";
import {
  ASC_LOCALES,
  DEFAULT_THEME,
  SET_FILE_LABELS,
  deliverPath,
  themeFromIcon,
  toAscLocale,
  writeDeliverFolder,
  zipDirectory,
  type IconColor,
  type RenderJob,
  type RenderResult,
  type Theme,
} from "@shotwright/render";
import { JobCancelled } from "../jobs/abort.ts";
import { readJson, writeJson, writeThumb, type Manifest } from "../jobs/artifacts.ts";
import { localeName } from "../jobs/state.ts";
import { cleanCaption, type CaptionResult, type CaptionWriter } from "./captions.ts";
import { renderShared } from "./renderer.ts";
import {
  DEFAULT_SETTINGS,
  FRAMES,
  MAX_SCREENS,
  SET_ORDER,
  TEMPLATES,
  captionIssues,
  type CaptionSource,
  type CaptionView,
  type CaptionsView,
  type ComposeSettings,
  type ComposeView,
  type RenderView,
  type SetView,
  type SuggestedTheme,
  type TemplateId,
  type ThemeSettings,
} from "./state.ts";

/** Bump when the renderer's output changes for the same inputs, so every image re-renders. */
const RENDER_VERSION = 1;

// --- Files in the run folder -----------------------------------------------------------

interface CaptionsFile {
  readonly version: 1;
  readonly updatedAt: string;
  readonly locales: Record<string, Record<string, { text: string; source: CaptionSource; original?: string }>>;
  readonly calls: Array<{ at: string; model: string; ms: number; calls: number; locales: string[]; usage: CaptionResult["usage"]; structuredOutput: boolean }>;
}

interface ThemeFile {
  readonly version: 1;
  readonly source: "icon" | "default";
  readonly icon?: string;
  readonly colors: readonly IconColor[];
  readonly dark: ThemeSettings;
  readonly light: ThemeSettings;
  readonly checkedAt: string;
}

interface RenderRecord {
  readonly position: number;
  readonly file: string;
  readonly thumb: string;
  readonly hash: string;
  readonly caption: string;
  readonly ms: number;
  readonly warnings: readonly string[];
  readonly captionScale?: number;
  readonly at: string;
}

interface ComposeFile {
  readonly version: 1;
  readonly settings: ComposeSettings;
  readonly updatedAt: string;
  /** set -> locale -> screen -> record. */
  readonly renders: Record<string, Record<string, Record<string, RenderRecord>>>;
}

const file = {
  manifest: "manifest.json",
  captions: "captions.json",
  theme: "theme.json",
  icon: "icon.png",
  compose: "compose.json",
};

// --- Locks -----------------------------------------------------------------------------

const LOCKS_KEY = Symbol.for("shotwright.composeLocks");
const locks = ((globalThis as Record<symbol, unknown>)[LOCKS_KEY] ??= new Map<string, Promise<unknown>>()) as Map<string, Promise<unknown>>;

/** Runs `task` after every earlier task on the same run folder has finished. */
export function withRunLock<T>(runDir: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(runDir) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  const tail = next.catch(() => undefined);
  locks.set(runDir, tail);
  void tail.then(() => {
    if (locks.get(runDir) === tail) locks.delete(runDir);
  });
  return next;
}

// --- Themes ----------------------------------------------------------------------------

function toSettings(theme: Theme): ThemeSettings {
  const bg = theme.background;
  const background =
    bg.kind === "gradient"
      ? { from: bg.from, to: bg.to, angle: bg.angle ?? 180 }
      : bg.kind === "solid"
        ? { from: bg.color, to: bg.color, angle: 180 }
        : { from: "#1d4ed8", to: "#0b1f5c", angle: 165 };
  return { background, captionColor: theme.captionColor, accent: theme.accent, deviceColor: theme.deviceColor ?? "dark" };
}

/** The renderer's Theme for editable settings (same stops: a solid color). */
export function toTheme(settings: ThemeSettings): Theme {
  const { from, to, angle } = settings.background;
  return {
    background: from.toLowerCase() === to.toLowerCase() ? { kind: "solid", color: from } : { kind: "gradient", from, to, angle },
    captionColor: settings.captionColor,
    accent: settings.accent,
    deviceColor: settings.deviceColor,
  };
}

const DEFAULT_DARK = toSettings(DEFAULT_THEME);
const DEFAULT_LIGHT: ThemeSettings = {
  background: { from: "#eef2ff", to: "#dbe4ff", angle: 180 },
  captionColor: "#111c44",
  accent: "#2563eb",
  deviceColor: "dark",
};

function suggestedTheme(theme: ThemeFile | undefined): SuggestedTheme {
  if (!theme) return { source: "default", colors: [], dark: DEFAULT_DARK, light: DEFAULT_LIGHT, checked: false };
  return {
    source: theme.source,
    ...(theme.icon && { icon: theme.icon }),
    colors: theme.colors.map((c) => c.hex),
    dark: theme.dark,
    light: theme.light,
    checked: true,
  };
}

/** Derives and saves theme.json (and icon.png) from the app icon; the default theme without one. */
export async function saveTheme(runDir: string, icon: Uint8Array | null): Promise<ThemeFile> {
  let theme: ThemeFile;
  if (icon) {
    const [dark, light] = await Promise.all([themeFromIcon(icon, "dark"), themeFromIcon(icon, "light")]);
    await writeFile(join(runDir, file.icon), icon);
    theme = {
      version: 1,
      source: "icon",
      icon: file.icon,
      colors: dark.colors,
      dark: toSettings(dark.theme),
      light: toSettings(light.theme),
      checkedAt: new Date().toISOString(),
    };
  } else {
    theme = { version: 1, source: "default", colors: [], dark: DEFAULT_DARK, light: DEFAULT_LIGHT, checkedAt: new Date().toISOString() };
  }
  await writeJson(join(runDir, file.theme), theme);
  return theme;
}

// --- Settings --------------------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/i;

/** Settings from untrusted input, merged over `base`; throws on anything malformed. */
export function parseSettings(input: unknown, base: ComposeSettings = DEFAULT_SETTINGS): ComposeSettings {
  if (input === undefined || input === null) return base;
  if (typeof input !== "object") throw new Error("Settings must be an object");
  const p = input as Record<string, unknown>;
  const template = p.template === undefined ? base.template : p.template;
  const frame = p.frame === undefined ? base.frame : p.frame;
  if (!TEMPLATES.some((t) => t.id === template)) throw new Error(`Unknown template: ${String(template)}`);
  if (!FRAMES.some((f) => f.id === frame)) throw new Error(`Unknown frame: ${String(frame)}`);
  let theme = base.theme;
  if (p.theme === null) theme = null;
  else if (p.theme !== undefined) {
    const t = p.theme as Record<string, unknown>;
    const bg = (t.background ?? {}) as Record<string, unknown>;
    const colors = [bg.from, bg.to, t.captionColor, t.accent];
    if (!colors.every((c) => typeof c === "string" && HEX.test(c))) throw new Error("Theme colors must be #rrggbb");
    const angle = typeof bg.angle === "number" && Number.isFinite(bg.angle) ? Math.round(bg.angle) % 360 : 180;
    if (t.deviceColor !== "dark" && t.deviceColor !== "light") throw new Error('deviceColor must be "dark" or "light"');
    theme = {
      background: { from: (bg.from as string).toLowerCase(), to: (bg.to as string).toLowerCase(), angle },
      captionColor: (t.captionColor as string).toLowerCase(),
      accent: (t.accent as string).toLowerCase(),
      deviceColor: t.deviceColor,
    };
  }
  return { template: template as TemplateId, frame: frame as ComposeSettings["frame"], theme };
}

// --- Reading a run ---------------------------------------------------------------------

interface RunFiles {
  readonly dir: string;
  readonly manifest: Manifest;
  readonly captions: CaptionsFile | undefined;
  readonly theme: ThemeFile | undefined;
  readonly compose: ComposeFile | undefined;
}

async function readRun(runDir: string): Promise<RunFiles> {
  const manifest = await readJson<Manifest>(join(runDir, file.manifest));
  if (!manifest) throw new Error("This run has no manifest.json yet; explore the app first.");
  const [captions, theme, compose] = await Promise.all([
    readJson<CaptionsFile>(join(runDir, file.captions)),
    readJson<ThemeFile>(join(runDir, file.theme)),
    readJson<ComposeFile>(join(runDir, file.compose)),
  ]);
  return { dir: runDir, manifest, captions, theme, compose };
}

/** The set a run's captures belong to: the explored device's, else guessed from its screen size. */
function setOf(manifest: Manifest): ScreenshotSetId {
  if (manifest.device.setId && manifest.device.setId in SCREENSHOT_SETS) return manifest.device.setId as ScreenshotSetId;
  const { width, height } = manifest.device.screen;
  if (width >= 700) return "ipad-13";
  if (width / height > 0.6) return "iphone-duo-outer";
  return "iphone-6.3";
}

interface CaptureSet {
  readonly set: ScreenshotSetId;
  /** locale -> screen -> capture file (relative to the run folder). */
  readonly captures: Map<string, Map<string, string>>;
}

/**
 * Captures per set and locale. Today a run explores one device, so there is one set; replays of other
 * devices (iPad, Duo outer/inner) become more entries here. The exploration's own screenshots stand
 * in for its locale until that locale is replayed.
 */
function captureSets(manifest: Manifest): CaptureSet[] {
  const set = setOf(manifest);
  const captures = new Map<string, Map<string, string>>();
  const screens = manifest.screens.slice(0, MAX_SCREENS);
  const locales = new Set<string>();
  for (const s of screens) for (const l of Object.keys(s.locales)) locales.add(l);
  locales.add(manifest.explorationLocale);
  const ordered = [manifest.explorationLocale, ...[...locales].filter((l) => l !== manifest.explorationLocale)];
  for (const locale of ordered) {
    const map = new Map<string, string>();
    for (const s of screens) {
      const replayed = s.locales[locale]?.file;
      const fileName = replayed ?? (locale === manifest.explorationLocale ? s.file : undefined);
      if (fileName) map.set(s.name, fileName);
    }
    if (map.size > 0) captures.set(locale, map);
  }
  return captures.size > 0 ? [{ set, captures }] : [];
}

function captionFor(run: RunFiles, locale: string, screen: string): CaptionView & { needed: boolean } {
  const stored = run.captions?.locales[locale]?.[screen];
  const appName = run.manifest.app.name;
  if (stored) {
    const issues = captionIssues(stored.text, locale, appName);
    return { text: stored.text, source: stored.source, ...(issues.length && { issues }), ...(stored.original && { original: stored.original }), needed: false };
  }
  const judge = run.manifest.screens.find((s) => s.name === screen)?.caption ?? "";
  const english = judge || screen.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  const source: CaptionSource = locale === "en" && judge ? "judge" : "fallback";
  const issues = captionIssues(english, locale, appName);
  return { text: english, source, ...(issues.length && { issues }), needed: true };
}

interface PlannedRender {
  readonly set: ScreenshotSetId;
  readonly locale: string;
  readonly screen: string;
  readonly position: number;
  readonly total: number;
  readonly caption: string;
  readonly capture: string;
  readonly hash: string;
  readonly file: string;
  readonly thumb: string;
  readonly theme: ThemeSettings;
}

async function plan(run: RunFiles, settings: ComposeSettings): Promise<PlannedRender[]> {
  const theme = settings.theme ?? suggestedTheme(run.theme).dark;
  const out: PlannedRender[] = [];
  for (const { set, captures } of captureSets(run.manifest)) {
    for (const [locale, screens] of captures) {
      const names = run.manifest.screens.map((s) => s.name).filter((n) => screens.has(n));
      for (const [i, screen] of names.entries()) {
        const capture = screens.get(screen)!;
        const info = await stat(join(run.dir, capture)).catch(() => null);
        if (!info) continue;
        const caption = captionFor(run, locale, screen).text;
        const position = i + 1;
        const hash = createHash("sha1")
          .update(
            JSON.stringify({
              v: RENDER_VERSION,
              set,
              locale,
              template: settings.template,
              frame: settings.frame,
              theme,
              caption,
              position,
              total: names.length,
              capture: [capture, info.size, Math.round(info.mtimeMs)],
            }),
          )
          .digest("hex")
          .slice(0, 12);
        const base = `${String(position).padStart(2, "0")}_${screen}`;
        out.push({
          set,
          locale,
          screen,
          position,
          total: names.length,
          caption,
          capture,
          hash,
          file: `renders/${set}/${locale}/${base}.png`,
          thumb: `renders/${set}/${locale}/thumbs/${base}.jpg`,
          theme,
        });
      }
    }
  }
  return out;
}

function renderView(p: PlannedRender, record: RenderRecord | undefined, fileExists: boolean): RenderView {
  const base = { screen: p.screen, position: p.position };
  if (!record || !fileExists) return { ...base, status: "missing" };
  const shown = {
    image: record.file,
    thumb: record.thumb,
    version: record.hash,
    ...(record.warnings.length && { warnings: record.warnings }),
    ...(record.captionScale !== undefined && { captionScale: record.captionScale }),
  };
  return { ...base, status: record.hash === p.hash ? "done" : "stale", ...shown };
}

function buildView(run: RunFiles, settings: ComposeSettings, planned: readonly PlannedRender[], exists: (rel: string) => boolean): ComposeView {
  const sets: SetView[] = [];
  const renders: Record<string, Record<string, RenderView[]>> = {};
  const byLocale: Record<string, Record<string, CaptionView>> = {};
  for (const p of planned) {
    const record = run.compose?.renders[p.set]?.[p.locale]?.[p.screen];
    ((renders[p.set] ??= {})[p.locale] ??= []).push(renderView(p, record, record ? exists(record.file) : false));
    if (!byLocale[p.locale]?.[p.screen]) {
      const { needed: _needed, ...caption } = captionFor(run, p.locale, p.screen);
      (byLocale[p.locale] ??= {})[p.screen] = caption;
    }
  }
  for (const id of SET_ORDER) {
    if (!renders[id]) continue;
    const spec = SCREENSHOT_SETS[id];
    sets.push({ id, label: spec.label, width: spec.portrait.width, height: spec.portrait.height, locales: Object.keys(renders[id]) });
  }
  const lastCall = run.captions?.calls.at(-1);
  const captions: CaptionsView = { byLocale, ...(lastCall && { model: lastCall.model, ms: lastCall.ms }) };
  return {
    settings,
    suggested: suggestedTheme(run.theme),
    captions,
    sets,
    screens: run.manifest.screens.slice(0, MAX_SCREENS).map((s) => s.name),
    renders,
    appName: run.manifest.app.name,
  };
}

/** What the Compose panel shows for a run, from its folder (no rendering, no model calls). */
export async function loadCompose(runDir: string): Promise<ComposeView | undefined> {
  if (!existsSync(join(runDir, file.manifest))) return undefined;
  const run = await readRun(runDir);
  const settings = run.compose?.settings ?? DEFAULT_SETTINGS;
  const planned = await plan(run, settings);
  if (planned.length === 0) return undefined;
  return buildView(run, settings, planned, (rel) => existsSync(join(runDir, rel)));
}

// --- Captions --------------------------------------------------------------------------

async function writeCaptions(runDir: string, captions: CaptionsFile): Promise<void> {
  await writeJson(join(runDir, file.captions), captions);
}

const emptyCaptions = (): CaptionsFile => ({ version: 1, updatedAt: new Date().toISOString(), locales: {}, calls: [] });

/** Saves a caption typed by the user. Empty text resets it: back to the one Muse wrote, else to English. */
export function setCaption(runDir: string, locale: string, screen: string, text: string): Promise<CaptionView> {
  return withRunLock(runDir, async () => {
    const run = await readRun(runDir);
    if (!run.manifest.screens.some((s) => s.name === screen)) throw new Error(`Unknown screen: ${screen}`);
    const captions = run.captions ?? emptyCaptions();
    const cleaned = cleanCaption(text).slice(0, 120);
    const locales = { ...captions.locales, [locale]: { ...captions.locales[locale] } };
    const stored = locales[locale]![screen];
    const original = stored?.source === "edited" ? stored.original : stored?.text;
    if (cleaned && cleaned === original) locales[locale]![screen] = { text: cleaned, source: "muse" };
    else if (cleaned) locales[locale]![screen] = { text: cleaned, source: "edited", ...(original && { original }) };
    else if (original) locales[locale]![screen] = { text: original, source: "muse" };
    else delete locales[locale]![screen];
    const next: CaptionsFile = { ...captions, updatedAt: new Date().toISOString(), locales };
    await writeCaptions(runDir, next);
    await updateManifest(runDir);
    const { needed: _needed, ...view } = captionFor({ ...run, captions: next }, locale, screen);
    return view;
  });
}

/** Asks the writer for every caption that is missing (or, with `all`, every one not edited by hand). */
async function ensureCaptions(run: RunFiles, writer: CaptionWriter, all: boolean, signal: AbortSignal | undefined): Promise<{ captions: CaptionsFile; result?: CaptionResult }> {
  const captions = run.captions ?? emptyCaptions();
  const sets = captureSets(run.manifest);
  const locales = [...new Set(sets.flatMap((s) => [...s.captures.keys()]))];
  const screens = run.manifest.screens.slice(0, MAX_SCREENS);
  const wanted = locales.filter((locale) =>
    screens.some((s) => {
      const stored = captions.locales[locale]?.[s.name];
      return !stored || (all && stored.source !== "edited");
    }),
  );
  if (wanted.length === 0) return { captions };
  const result = await writer(
    {
      appName: run.manifest.app.name,
      description: run.manifest.app.description,
      screens: screens.map((s) => ({ name: s.name, draft: s.caption, shows: s.why })),
      locales: wanted,
    },
    signal,
  );
  const next: CaptionsFile["locales"] = { ...captions.locales };
  for (const locale of wanted) {
    const current = { ...next[locale] };
    for (const s of screens) {
      const text = result.captions[locale]?.[s.name];
      const stored = current[s.name];
      if (!text || stored?.source === "edited" || (stored && !all)) continue;
      current[s.name] = { text, source: "muse" };
    }
    next[locale] = current;
  }
  const updated: CaptionsFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    locales: next,
    calls: [
      ...captions.calls,
      { at: new Date().toISOString(), model: result.model, ms: result.ms, calls: result.calls, locales: wanted, usage: result.usage, structuredOutput: result.structuredOutput },
    ],
  };
  return { captions: updated, result };
}

/** Locales that still have captions to write (none stored for some screen). */
export async function captionsMissing(runDir: string): Promise<string[]> {
  const run = await readRun(runDir);
  const locales = [...new Set(captureSets(run.manifest).flatMap((s) => [...s.captures.keys()]))];
  return locales.filter((l) => run.manifest.screens.slice(0, MAX_SCREENS).some((s) => !run.captions?.locales[l]?.[s.name]));
}

// --- Manifest --------------------------------------------------------------------------

/**
 * Adds compose results to a manifest: captions per screen and locale, the rendered files in order,
 * and the compose files. The job manager rebuilds manifest.json after every replay; it calls this
 * too, so nothing is lost.
 */
export async function withComposeInfo(manifest: Manifest, runDir: string): Promise<Manifest> {
  const [captions, theme, compose] = await Promise.all([
    readJson<CaptionsFile>(join(runDir, file.captions)),
    readJson<ThemeFile>(join(runDir, file.theme)),
    readJson<ComposeFile>(join(runDir, file.compose)),
  ]);
  const screens = manifest.screens.map((s) => {
    const byLocale: Record<string, string> = {};
    for (const [locale, list] of Object.entries(captions?.locales ?? {})) if (list[s.name]) byLocale[locale] = list[s.name]!.text;
    return Object.keys(byLocale).length ? { ...s, captions: byLocale } : s;
  });
  let renders: Record<string, Record<string, string[]>> | undefined;
  if (compose) {
    renders = {};
    for (const [set, locales] of Object.entries(compose.renders)) {
      for (const [locale, records] of Object.entries(locales)) {
        (renders[set] ??= {})[locale] = Object.values(records)
          .sort((a, b) => a.position - b.position)
          .map((r) => r.file);
      }
    }
  }
  return {
    ...manifest,
    screens,
    ...(renders && { renders }),
    files: {
      ...manifest.files,
      ...(captions && { captions: file.captions }),
      ...(theme && { theme: file.theme }),
      ...(theme?.icon && { icon: theme.icon }),
      ...(compose && { compose: file.compose }),
    },
  };
}

async function updateManifest(runDir: string): Promise<void> {
  const manifest = await readJson<Manifest>(join(runDir, file.manifest));
  if (manifest) await writeJson(join(runDir, file.manifest), { ...(await withComposeInfo(manifest, runDir)), updatedAt: new Date().toISOString() });
}

// --- Compose ---------------------------------------------------------------------------

export type ComposeEvent =
  | { readonly type: "phase"; readonly phase: "captions" | "theme" | "render"; readonly label: string }
  | { readonly type: "view"; readonly view: ComposeView }
  | { readonly type: "render"; readonly set: string; readonly locale: string; readonly render: RenderView }
  | { readonly type: "progress"; readonly done: number; readonly total: number };

export interface ComposeOptions {
  /** Merged over the saved settings, then saved. */
  readonly settings?: Partial<ComposeSettings>;
  /** Writes missing captions. Without one, missing captions use the English caption (no model calls). */
  readonly captionWriter?: CaptionWriter;
  /** Rewrite every caption that was not edited by hand (needs `captionWriter`). */
  readonly regenerateCaptions?: boolean;
  /** Reads the app icon when the run has no theme.json yet; null for none. Without it, the default theme. */
  readonly icon?: () => Promise<Uint8Array | null>;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: ComposeEvent) => void;
  /** Default: the shared renderer. */
  readonly render?: (job: RenderJob) => Promise<RenderResult>;
  /** Images rendered at once. Default 2 (the shared renderer's page pool). */
  readonly concurrency?: number;
}

export interface ComposeSummary {
  readonly view: ComposeView;
  readonly rendered: number;
  readonly upToDate: number;
  readonly failed: number;
  readonly captions?: CaptionResult;
  readonly ms: { readonly total: number; readonly captions: number; readonly theme: number; readonly render: number };
  /** Per image: capture, layout + screenshot + encode, in ms. */
  readonly renders: ReadonlyArray<{ readonly file: string; readonly ms: number; readonly warnings: readonly string[] }>;
}

const checkAbort = (signal: AbortSignal | undefined) => {
  if (signal?.aborted) throw new JobCancelled();
};

async function removeOrphans(runDir: string, records: ComposeFile["renders"]): Promise<void> {
  const keep = new Set<string>();
  for (const locales of Object.values(records)) for (const list of Object.values(locales)) for (const r of Object.values(list)) keep.add(r.file).add(r.thumb);
  const root = join(runDir, "renders");
  if (!existsSync(root)) return;
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(runDir, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (!keep.has(child)) await rm(join(runDir, child), { force: true });
    }
  };
  await walk("renders");
}

/**
 * Captions (missing ones), theme (once, from the app icon), then every screenshot whose inputs
 * changed since it was last rendered. Cancellable between images.
 */
export function composeRun(runDir: string, options: ComposeOptions = {}): Promise<ComposeSummary> {
  return withRunLock(runDir, () => composeLocked(runDir, options));
}

async function composeLocked(runDir: string, options: ComposeOptions): Promise<ComposeSummary> {
  const started = performance.now();
  const { signal, onEvent } = options;
  const render = options.render ?? renderShared;
  let run = await readRun(runDir);
  const settings = parseSettings(options.settings ?? {}, run.compose?.settings ?? DEFAULT_SETTINGS);
  const exists = (rel: string) => existsSync(join(runDir, rel));
  const emitView = async () => onEvent?.({ type: "view", view: buildView(run, settings, await plan(run, settings), exists) });

  // Save the settings first, so the page shows them while the rest runs.
  let compose: ComposeFile = { version: 1, settings, updatedAt: new Date().toISOString(), renders: run.compose?.renders ?? {} };
  await writeJson(join(runDir, file.compose), compose);
  run = { ...run, compose };
  await emitView();

  // 1. Captions.
  let captionsMs = 0;
  let captionResult: CaptionResult | undefined;
  if (options.captionWriter) {
    const missing = (await captionsMissing(runDir)).length > 0;
    if (missing || options.regenerateCaptions) {
      onEvent?.({ type: "phase", phase: "captions", label: "Writing captions for every language" });
      const t = performance.now();
      const { captions, result } = await ensureCaptions(run, options.captionWriter, options.regenerateCaptions ?? false, signal);
      checkAbort(signal);
      captionsMs = performance.now() - t;
      captionResult = result;
      if (result) {
        await writeCaptions(runDir, captions);
        run = { ...run, captions };
        await emitView();
      }
    }
  }

  // 2. Theme from the app icon, once.
  let themeMs = 0;
  if (!run.theme && options.icon) {
    onEvent?.({ type: "phase", phase: "theme", label: "Reading the app icon" });
    const t = performance.now();
    let icon: Uint8Array | null = null;
    try {
      icon = await options.icon();
    } catch (error) {
      if (error instanceof JobCancelled || signal?.aborted) throw error;
      icon = null;
    }
    checkAbort(signal);
    run = { ...run, theme: await saveTheme(runDir, icon) };
    themeMs = performance.now() - t;
    await emitView();
  }

  // 3. Render what changed.
  onEvent?.({ type: "phase", phase: "render", label: "Rendering screenshots" });
  const planned = await plan(run, settings);
  const renders: ComposeFile["renders"] = {};
  const todo: PlannedRender[] = [];
  for (const p of planned) {
    const record = run.compose?.renders[p.set]?.[p.locale]?.[p.screen];
    if (record && record.hash === p.hash && record.file === p.file && exists(record.file)) {
      ((renders[p.set] ??= {})[p.locale] ??= {})[p.screen] = record;
    } else {
      todo.push(p);
      // Keep the old record (shown as stale) until the new image is there.
      if (record && exists(record.file)) ((renders[p.set] ??= {})[p.locale] ??= {})[p.screen] = record;
    }
  }
  const upToDate = planned.length - todo.length;
  compose = { ...compose, renders };
  run = { ...run, compose };
  for (const p of todo) {
    const old = renders[p.set]?.[p.locale]?.[p.screen];
    onEvent?.({ type: "render", set: p.set, locale: p.locale, render: { ...renderView(p, old, Boolean(old)), status: "queued" } });
  }
  let done = upToDate;
  onEvent?.({ type: "progress", done, total: planned.length });

  const t3 = performance.now();
  const log: Array<{ file: string; ms: number; warnings: readonly string[] }> = [];
  let failed = 0;
  let next = 0;
  let saving = Promise.resolve();
  const save = () => {
    const snapshot: ComposeFile = { ...compose, updatedAt: new Date().toISOString(), renders: structuredClone(renders) };
    saving = saving.then(() => writeJson(join(runDir, file.compose), snapshot));
  };
  const worker = async () => {
    while (next < todo.length) {
      checkAbort(signal);
      const p = todo[next++]!;
      const old = renders[p.set]?.[p.locale]?.[p.screen];
      onEvent?.({ type: "render", set: p.set, locale: p.locale, render: { ...renderView(p, old, Boolean(old)), status: "rendering" } });
      try {
        const result = await render({
          set: p.set,
          template: settings.template,
          frame: settings.frame,
          capture: join(runDir, p.capture),
          caption: p.caption,
          locale: p.locale,
          theme: toTheme(p.theme),
          index: p.position - 1,
          total: p.total,
        });
        await mkdir(join(runDir, `renders/${p.set}/${p.locale}/thumbs`), { recursive: true });
        await writeFile(join(runDir, p.file), result.bytes);
        await writeThumb(result.bytes, join(runDir, p.thumb));
        const record: RenderRecord = {
          position: p.position,
          file: p.file,
          thumb: p.thumb,
          hash: p.hash,
          caption: p.caption,
          ms: Math.round(result.ms.total),
          warnings: result.warnings,
          ...(result.caption && { captionScale: Math.round((result.caption.fontSize / result.caption.baseSize) * 100) / 100 }),
          at: new Date().toISOString(),
        };
        ((renders[p.set] ??= {})[p.locale] ??= {})[p.screen] = record;
        log.push({ file: p.file, ms: record.ms, warnings: record.warnings });
        save();
        onEvent?.({ type: "render", set: p.set, locale: p.locale, render: renderView(p, record, true) });
      } catch (error) {
        if (error instanceof JobCancelled || signal?.aborted) throw error;
        failed++;
        const message = error instanceof Error ? error.message.split("\n")[0]!.slice(0, 300) : String(error);
        onEvent?.({ type: "render", set: p.set, locale: p.locale, render: { ...renderView(p, old, Boolean(old)), status: "failed", error: message } });
      }
      done++;
      onEvent?.({ type: "progress", done, total: planned.length });
    }
  };
  try {
    // allSettled: a cancelled run returns only after the render still in flight on the other page
    // has finished, so nothing writes to the folder once the run lock is released.
    const results = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 2, todo.length)) }, worker));
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (rejected) throw rejected.reason;
  } finally {
    save();
    await saving;
  }
  const renderMs = performance.now() - t3;
  if (failed === 0) await removeOrphans(runDir, renders);
  await updateManifest(runDir);
  const view = buildView(run, settings, planned, exists);
  onEvent?.({ type: "view", view });
  return {
    view,
    rendered: log.length,
    upToDate,
    failed,
    ...(captionResult && { captions: captionResult }),
    ms: { total: performance.now() - started, captions: captionsMs, theme: themeMs, render: renderMs },
    renders: log,
  };
}

// --- Previews --------------------------------------------------------------------------

const previewCache = new Map<string, string>();

/**
 * The first screenshot in every template with these settings, as small JPEG data URLs (template
 * picker). Uses the shared renderer; nothing is written to the run folder.
 */
export async function renderPreviews(runDir: string, input: unknown, locale?: string): Promise<Record<string, string>> {
  const run = await readRun(runDir);
  const settings = parseSettings(input, run.compose?.settings ?? DEFAULT_SETTINGS);
  const sets = captureSets(run.manifest);
  const first = sets[0];
  if (!first) throw new Error("Nothing to preview: no captures in this run.");
  const lang = locale && first.captures.has(locale) ? locale : [...first.captures.keys()][0]!;
  const captures = first.captures.get(lang)!;
  const screen = run.manifest.screens.find((s) => captures.has(s.name))!;
  const capture = join(runDir, captures.get(screen.name)!);
  const info = await stat(capture);
  const theme = settings.theme ?? suggestedTheme(run.theme).dark;
  const caption = captionFor(run, lang, screen.name).text;
  const total = Math.min(run.manifest.screens.length, MAX_SCREENS);
  const out: Record<string, string> = {};
  await Promise.all(
    TEMPLATES.map(async ({ id }) => {
      const key = JSON.stringify([runDir, id, settings.frame, theme, caption, lang, capture, info.mtimeMs, total]);
      let url = previewCache.get(key);
      if (!url) {
        const result = await renderShared({
          set: first.set,
          template: id,
          frame: settings.frame,
          capture,
          caption,
          locale: lang,
          theme: toTheme(theme),
          index: 0,
          total,
          format: "jpeg",
          jpegQuality: 85,
        });
        const w = 216;
        const jpeg = await downscale(result.bytes, w, Math.round((w * result.height) / result.width), 80);
        url = `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`;
        previewCache.set(key, url);
        if (previewCache.size > 60) previewCache.delete(previewCache.keys().next().value!);
      }
      out[id] = url;
    }),
  );
  return out;
}

// --- Export ----------------------------------------------------------------------------

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "app";

export interface ExportResult {
  /** The zip on disk. */
  readonly file: string;
  /** Download name: `<app>-screenshots.zip`. */
  readonly name: string;
  readonly entries: number;
  readonly bytes: number;
  /** Paths inside the zip. */
  readonly files: readonly string[];
  /** Images that had to be rendered first (stale or missing). */
  readonly rendered: number;
}

function readme(run: RunFiles, files: readonly string[], compose: ComposeFile, generatedAt: Date): string {
  const m = run.manifest;
  const sets = Object.keys(compose.renders) as ScreenshotSetId[];
  const locales = [...new Set(sets.flatMap((s) => Object.keys(compose.renders[s] ?? {})))];
  const shots = files.filter((f) => f.endsWith(".png")).length;
  const setLines = sets.map((s) => {
    const spec = SCREENSHOT_SETS[s];
    const per = Object.values(compose.renders[s] ?? {})[0];
    return `  ${spec.label} (${spec.portrait.width} x ${spec.portrait.height}), file label "${SET_FILE_LABELS[s]}", ${per ? Object.keys(per).length : 0} per language`;
  });
  const ascName = (code: string) => ASC_LOCALES.find((l) => l.code === code)?.name ?? code;
  const localeLines = locales.map((l) => `  ${l.padEnd(8)} -> ${toAscLocale(l).padEnd(8)} ${ascName(toAscLocale(l))}`);
  const captionLines: string[] = [];
  for (const set of sets.slice(0, 1)) {
    for (const locale of locales) {
      const records = Object.entries(compose.renders[set]?.[locale] ?? {}).sort((a, b) => a[1].position - b[1].position);
      for (const [screen, r] of records) captionLines.push(`  ${locale.padEnd(8)} ${String(r.position).padStart(2, "0")}  ${screen.padEnd(30)} ${r.caption.replace(/\*/g, "")}`);
    }
  }
  return [
    `${m.app.name}: App Store screenshots`,
    `Made with Shotwright (https://github.com/ShortsAlpha/shotwright) on ${generatedAt.toISOString().slice(0, 10)}, run ${m.runId}.`,
    "",
    "CONTENTS",
    `  ${shots} screenshots in ${locales.length} language${locales.length === 1 ? "" : "s"}: PNG, sRGB, no alpha, exact App Store sizes.`,
    ...setLines,
    "  screenshots/<App Store Connect locale>/<nn>_<set>_<screen>.png   (nn = order on the product page)",
    "",
    "UPLOAD WITH FASTLANE DELIVER (from the folder this file is in)",
    `  fastlane deliver --app_identifier ${m.app.bundleId || "<your.bundle.id>"} --screenshots_path ./screenshots --skip_binary_upload --skip_metadata --overwrite_screenshots --force`,
    "",
    "  --overwrite_screenshots replaces the screenshots already in App Store Connect for these",
    "  languages and sizes. Sign in with an App Store Connect API key (add --api_key_path key.json)",
    "  or your Apple ID. deliver picks the display type from the pixel size and the order from the",
    "  file names; check that your fastlane version knows these sizes.",
    "",
    "UPLOAD BY HAND",
    "  In App Store Connect, open the app version, choose each language from the menu and drag the",
    "  files of its folder into the matching screenshot well, in file-name order.",
    "",
    "LANGUAGES (Shotwright -> App Store Connect folder)",
    ...localeLines,
    "",
    "CAPTIONS",
    ...captionLines,
    "",
  ].join("\n");
}

/**
 * Builds `<app>-screenshots.zip` (fastlane deliver layout plus README.txt) from the run's renders.
 * Stale or missing images are rendered first, without model calls (missing captions fall back to English).
 */
export async function exportZip(runDir: string, options: { readonly signal?: AbortSignal; readonly render?: ComposeOptions["render"] } = {}): Promise<ExportResult> {
  // Bring renders up to date (a no-op when the last compose finished).
  const summary = await composeRun(runDir, { ...(options.signal && { signal: options.signal }), ...(options.render && { render: options.render }) });
  if (summary.failed > 0) throw new Error(`${summary.failed} screenshot${summary.failed === 1 ? "" : "s"} failed to render; compose again.`);
  return withRunLock(runDir, async () => {
    const run = await readRun(runDir);
    const compose = run.compose;
    if (!compose || Object.keys(compose.renders).length === 0) throw new Error("Nothing to export yet: compose the screenshots first.");
    const items = [];
    for (const [set, locales] of Object.entries(compose.renders)) {
      for (const [locale, records] of Object.entries(locales)) {
        for (const [screen, r] of Object.entries(records)) {
          items.push({ locale, set: set as ScreenshotSetId, screen, position: r.position, bytes: new Uint8Array(await readFile(join(runDir, r.file))) });
        }
      }
    }
    items.sort((a, b) => deliverPath(a).localeCompare(deliverPath(b)));
    const exportDir = join(runDir, "export");
    const stage = join(exportDir, "deliver");
    await rm(stage, { recursive: true, force: true });
    const written = await writeDeliverFolder(stage, items);
    const now = new Date();
    await writeFile(join(stage, "README.txt"), readme(run, written.files, compose, now));
    const name = `${slug(run.manifest.app.name)}-screenshots.zip`;
    const zipFile = join(exportDir, name);
    const zipped = zipDirectory(stage, zipFile);
    return { file: zipFile, name, entries: zipped.entries, bytes: zipped.bytes, files: ["README.txt", ...written.files], rendered: summary.rendered };
  });
}

/** For logs: "18 screenshots (iPhone 6.3" in English, Deutsch, 日本語)". */
export function describeView(view: ComposeView): string {
  const count = Object.values(view.renders).reduce((n, locales) => n + Object.values(locales).reduce((m, list) => m + list.length, 0), 0);
  const sets = view.sets.map((s) => `${s.label} in ${s.locales.map(localeName).join(", ")}`).join("; ");
  return `${count} screenshots (${sets})`;
}
