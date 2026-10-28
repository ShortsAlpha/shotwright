/**
 * Downloads the bundled fonts (all SIL OFL 1.1) from the Fontsource CDN, which repackages
 * Google Fonts as WOFF2, and their OFL texts from github.com/google/fonts.
 *
 *   node packages/render/scripts/fetch-fonts.ts
 *
 * Writes fonts/files/*.woff2, fonts/licenses/*-OFL.txt, fonts/manifest.json and fonts/LICENSES.md.
 * The result is committed, so rendering never needs the network. Run it again only to update fonts.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface FontSpec {
  /** Fontsource id, e.g. "noto-sans-jp". */
  readonly id: string;
  /** Directory in github.com/google/fonts (ofl/<dir>/OFL.txt). */
  readonly gfDir: string;
  readonly subsets: readonly string[];
  /** Variable font (wght axis) or one static weight. */
  readonly weight: "variable" | number;
  readonly scripts: string;
}

const FONTS: readonly FontSpec[] = [
  { id: "inter", gfDir: "inter", weight: "variable", scripts: "Latin, Cyrillic, Greek, Vietnamese", subsets: ["latin", "latin-ext", "cyrillic", "cyrillic-ext", "greek", "greek-ext", "vietnamese"] },
  { id: "noto-sans-arabic", gfDir: "notosansarabic", weight: "variable", scripts: "Arabic (ar, fa, ur)", subsets: ["arabic"] },
  { id: "noto-sans-hebrew", gfDir: "notosanshebrew", weight: "variable", scripts: "Hebrew (he)", subsets: ["hebrew"] },
  { id: "noto-sans-thai", gfDir: "notosansthai", weight: "variable", scripts: "Thai (th)", subsets: ["thai"] },
  { id: "noto-sans-devanagari", gfDir: "notosansdevanagari", weight: "variable", scripts: "Devanagari (hi, mr)", subsets: ["devanagari"] },
  { id: "noto-sans-bengali", gfDir: "notosansbengali", weight: "variable", scripts: "Bengali (bn)", subsets: ["bengali"] },
  { id: "noto-sans-gujarati", gfDir: "notosansgujarati", weight: "variable", scripts: "Gujarati (gu)", subsets: ["gujarati"] },
  { id: "noto-sans-gurmukhi", gfDir: "notosansgurmukhi", weight: "variable", scripts: "Gurmukhi (pa)", subsets: ["gurmukhi"] },
  { id: "noto-sans-kannada", gfDir: "notosanskannada", weight: "variable", scripts: "Kannada (kn)", subsets: ["kannada"] },
  { id: "noto-sans-malayalam", gfDir: "notosansmalayalam", weight: "variable", scripts: "Malayalam (ml)", subsets: ["malayalam"] },
  { id: "noto-sans-oriya", gfDir: "notosansoriya", weight: "variable", scripts: "Odia (or)", subsets: ["oriya"] },
  { id: "noto-sans-tamil", gfDir: "notosanstamil", weight: "variable", scripts: "Tamil (ta)", subsets: ["tamil"] },
  { id: "noto-sans-telugu", gfDir: "notosanstelugu", weight: "variable", scripts: "Telugu (te)", subsets: ["telugu"] },
  { id: "noto-sans-jp", gfDir: "notosansjp", weight: 700, scripts: "Japanese (ja)", subsets: ["japanese"] },
  { id: "noto-sans-kr", gfDir: "notosanskr", weight: 700, scripts: "Korean (ko)", subsets: ["korean"] },
  { id: "noto-sans-sc", gfDir: "notosanssc", weight: 700, scripts: "Simplified Chinese (zh-Hans)", subsets: ["chinese-simplified"] },
  { id: "noto-sans-tc", gfDir: "notosanstc", weight: 700, scripts: "Traditional Chinese (zh-Hant)", subsets: ["chinese-traditional"] },
];

interface ApiFont {
  family: string;
  version: string;
  npmVersion: string;
  license: string;
  variable: boolean;
  unicodeRange: Record<string, string>;
}

export interface ManifestFile {
  readonly file: string;
  readonly subset: string;
  readonly unicodeRange?: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ManifestFont {
  readonly id: string;
  readonly family: string;
  readonly weight: string;
  readonly version: string;
  readonly license: string;
  readonly scripts: string;
  readonly source: string;
  readonly licenseFile: string;
  readonly copyright: string;
  readonly files: readonly ManifestFile[];
}

const fontsDir = fileURLToPath(new URL("../fonts/", import.meta.url));
const filesDir = join(fontsDir, "files");
const licensesDir = join(fontsDir, "licenses");

async function get(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main(): Promise<void> {
  mkdirSync(filesDir, { recursive: true });
  mkdirSync(licensesDir, { recursive: true });
  const manifest: ManifestFont[] = [];

  for (const spec of FONTS) {
    const api = JSON.parse((await get(`https://api.fontsource.org/v1/fonts/${spec.id}`)).toString("utf8")) as ApiFont;
    if (api.license !== "OFL-1.1") throw new Error(`${spec.id}: unexpected license ${api.license}`);
    if (spec.weight === "variable" && !api.variable) throw new Error(`${spec.id}: no variable font on Fontsource`);
    const files: ManifestFile[] = [];
    for (const subset of spec.subsets) {
      const name = spec.weight === "variable" ? `${subset}-wght-normal.woff2` : `${subset}-${spec.weight}-normal.woff2`;
      const pkg = spec.weight === "variable" ? `${spec.id}:vf@${api.npmVersion}` : `${spec.id}@${api.npmVersion}`;
      const bytes = await get(`https://cdn.jsdelivr.net/fontsource/fonts/${pkg}/${name}`);
      if (bytes.subarray(0, 4).toString("latin1") !== "wOF2") throw new Error(`${spec.id}/${name}: not a WOFF2 file`);
      const file = `${spec.id}-${name}`;
      writeFileSync(join(filesDir, file), bytes);
      const unicodeRange = api.unicodeRange[subset];
      files.push({
        file,
        subset,
        ...(unicodeRange ? { unicodeRange } : {}),
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    const ofl = (await get(`https://raw.githubusercontent.com/google/fonts/main/ofl/${spec.gfDir}/OFL.txt`)).toString("utf8");
    const licenseFile = `${spec.id}-OFL.txt`;
    writeFileSync(join(licensesDir, licenseFile), ofl);
    manifest.push({
      id: spec.id,
      family: api.family,
      weight: spec.weight === "variable" ? "100 900" : String(spec.weight),
      version: `${api.version} (fontsource ${api.npmVersion})`,
      license: api.license,
      scripts: spec.scripts,
      source: `https://github.com/google/fonts/tree/main/ofl/${spec.gfDir}`,
      licenseFile: `licenses/${licenseFile}`,
      copyright: ofl.split("\n")[0]!.trim(),
      files,
    });
    console.log(`${api.family}: ${files.map((f) => `${f.subset} ${(f.bytes / 1024).toFixed(0)} KB`).join(", ")}`);
  }

  writeFileSync(join(fontsDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(fontsDir, "LICENSES.md"), licensesMarkdown(manifest));
  const total = manifest.flatMap((f) => f.files).reduce((n, f) => n + f.bytes, 0);
  console.log(`total ${(total / 1024 / 1024).toFixed(2)} MB`);
}

function licensesMarkdown(fonts: readonly ManifestFont[]): string {
  const rows = fonts.map((f) => {
    const kb = f.files.reduce((n, x) => n + x.bytes, 0) / 1024;
    return `| ${f.family} | ${f.scripts} | ${f.weight === "100 900" ? "variable 100–900" : f.weight} | ${f.version} | ${f.copyright.replace(/\|/g, "\\|")} | [OFL-1.1](${f.licenseFile}) | ${kb.toFixed(0)} KB |`;
  });
  return `# Bundled fonts

Every font in \`files/\` is licensed under the **SIL Open Font License 1.1** (OFL-1.1). The full
license text for each family, with its copyright line, is in \`licenses/\`. The OFL allows bundling,
embedding and redistributing the fonts with software, including commercial software, as long as the
fonts are not sold on their own and the license travels with them. None of the fonts is renamed or
modified by us; we do not use any Reserved Font Name.

Source: Google Fonts (github.com/google/fonts), as WOFF2 files repackaged by Fontsource
(cdn.jsdelivr.net/fontsource). Latin-script and Indic families are variable fonts (wght axis);
CJK families are the Bold (700) weight of the Google Fonts language subset (common characters of
that language) to keep the repository small. Regenerate with \`npm run fonts:fetch -w @shotwright/render\`;
\`manifest.json\` records each file's unicode range, size and SHA-256.

| Family | Scripts (locales) | Weights | Version | Copyright | License | Size |
|---|---|---|---|---|---|---|
${rows.join("\n")}
`;
}

await main();
