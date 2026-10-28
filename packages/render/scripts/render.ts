/**
 * Render a folder of captures with a JSON spec into the fastlane `deliver` layout.
 *
 *   node packages/render/scripts/render.ts --spec spec.json --captures <dir> --out <dir> [--zip] [--sheet] [--concurrency 2]
 *
 * Captures: <dir>/<set>/<locale>/<screen>.png if that exists, else <dir>/<locale>/<screen>.png
 * (the explorer's replay output). Output: <out>/screenshots/<asc-locale>/<nn>_<set>_<screen>.png,
 * plus <out>/screenshots.zip with --zip and <out>/contact-sheet.jpg with --sheet.
 *
 * Spec (paths relative to the spec file):
 *   {
 *     "sets": ["iphone-6.3", "ipad-13"],                 // default: all four
 *     "template": "caption-top",                          // caption-top | bleed | panorama
 *     "frame": "device",                                  // device | none | full-bleed
 *     "captionPosition": "top",                           // bleed only
 *     "format": "png",                                    // png | jpeg
 *     "theme": { "background": { "kind": "gradient", "from": "#2666c9", "to": "#15386f" },
 *                "captionColor": "#ffffff", "accent": "#e8843b" },
 *     "themeFromIcon": "AppIcon-1024.png",                // instead of "theme"
 *     "themeMode": "dark",                                // dark | light (with themeFromIcon)
 *     "screens": ["home-overview", "calendar-month"],     // App Store order
 *     "captions": { "en": { "home-overview": "All renewals *at a glance*" }, "de": { … } }
 *   }
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SCREENSHOT_SET_IDS, type ScreenshotSetId } from "@shotwright/core";
import {
  TEMPLATE_IDS,
  contactSheet,
  createRenderer,
  themeFromIcon,
  writeDeliverFolder,
  zipDirectory,
  type DeliverItem,
  type FrameStyle,
  type RenderJob,
  type TemplateId,
  type Theme,
} from "../src/index.ts";

interface Spec {
  sets?: ScreenshotSetId[];
  template?: TemplateId;
  frame?: FrameStyle;
  captionPosition?: "top" | "bottom";
  format?: "png" | "jpeg";
  theme?: Theme;
  themeFromIcon?: string;
  themeMode?: "dark" | "light";
  screens: string[];
  captions: Record<string, Record<string, string>>;
}

const { values } = parseArgs({
  options: {
    spec: { type: "string" },
    captures: { type: "string" },
    out: { type: "string" },
    zip: { type: "boolean", default: false },
    sheet: { type: "boolean", default: false },
    concurrency: { type: "string", default: "2" },
  },
});
if (!values.spec || !values.captures || !values.out) {
  console.error("usage: render.ts --spec spec.json --captures <dir> --out <dir> [--zip] [--sheet] [--concurrency 2]");
  process.exit(2);
}

const specPath = resolve(values.spec);
const spec = JSON.parse(readFileSync(specPath, "utf8")) as Spec;
const rel = (p: string) => (isAbsolute(p) ? p : join(dirname(specPath), p));
const sets = spec.sets ?? SCREENSHOT_SET_IDS;
for (const s of sets) if (!SCREENSHOT_SET_IDS.includes(s)) throw new Error(`Unknown set ${s}; one of ${SCREENSHOT_SET_IDS.join(", ")}`);
const template = spec.template ?? "caption-top";
if (!TEMPLATE_IDS.includes(template)) throw new Error(`Unknown template ${template}; one of ${TEMPLATE_IDS.join(", ")}`);
if (!Array.isArray(spec.screens) || !spec.screens.length) throw new Error("spec.screens must list the screens in App Store order");

let theme = spec.theme;
if (!theme && spec.themeFromIcon) {
  const derived = await themeFromIcon(rel(spec.themeFromIcon), spec.themeMode ?? "dark");
  theme = derived.theme;
  console.log(`theme from icon: ${derived.colors.map((c) => c.hex).join(" ")}`);
}
if (theme?.background.kind === "image" && typeof theme.background.src === "string" && !/^(https?|data):/.test(theme.background.src)) {
  theme = { ...theme, background: { ...theme.background, src: rel(theme.background.src) } };
}

const captures = resolve(values.captures);
const capturePath = (set: string, locale: string, screen: string): string => {
  for (const p of [join(captures, set, locale, `${screen}.png`), join(captures, locale, `${screen}.png`)]) if (existsSync(p)) return p;
  throw new Error(`No capture for ${set}/${locale}/${screen} under ${captures}`);
};

const jobs: (RenderJob & { screen: string; position: number; locale: string })[] = [];
for (const set of sets) {
  for (const [locale, captions] of Object.entries(spec.captions)) {
    spec.screens.forEach((screen, i) => {
      jobs.push({
        set,
        template,
        frame: spec.frame ?? "device",
        captionPosition: spec.captionPosition ?? "top",
        format: spec.format ?? "png",
        capture: capturePath(set, locale, screen),
        caption: captions[screen] ?? "",
        locale,
        ...(theme ? { theme } : {}),
        index: i,
        total: spec.screens.length,
        screen,
        position: i + 1,
      });
    });
  }
}

const out = resolve(values.out);
const renderer = await createRenderer({ concurrency: Number(values.concurrency) });
const t0 = performance.now();
const items: DeliverItem[] = [];
try {
  const results = await renderer.renderMany(jobs, (i, r) => {
    const j = jobs[i]!;
    const w = r.warnings.filter((x) => !x.startsWith("capture "));
    console.log(
      `${String(i + 1).padStart(3)}/${jobs.length} ${j.set} ${j.locale} ${j.screen} ${Math.round(r.ms.total)} ms` +
        (r.caption ? ` caption ${r.caption.fontSize}px/${r.caption.lines}L` : "") +
        (w.length ? `  ! ${w.join("; ")}` : ""),
    );
  });
  results.forEach((r, i) => {
    const j = jobs[i]!;
    items.push({ locale: j.locale, set: j.set, screen: j.screen, position: j.position, bytes: r.bytes, format: r.format });
  });
} finally {
  await renderer.close();
}
const wall = performance.now() - t0;
const written = await writeDeliverFolder(out, items, { clean: true });
console.log(`${written.files.length} files in ${join(out, "screenshots")} (${(wall / 1000).toFixed(1)} s, ${Math.round(wall / jobs.length)} ms/image)`);
if (values.zip) {
  const zip = join(out, "screenshots.zip");
  const { entries, bytes } = zipDirectory(join(out, "screenshots"), zip, { prefix: "screenshots" });
  console.log(`${zip}: ${entries} entries, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
}
if (values.sheet) {
  const sheet = join(out, "contact-sheet.jpg");
  const columns = spec.screens.length;
  writeFileSync(sheet, await contactSheet(written.files.map((f) => ({ image: join(out, f), label: f.split("/").slice(1).join("/") })), { columns, thumbHeight: 480 }));
  console.log(sheet);
}
