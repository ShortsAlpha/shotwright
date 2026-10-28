/**
 * Bundled fonts (fonts/manifest.json, written by scripts/fetch-fonts.ts) as @font-face rules.
 * The renderer serves fonts/files/* to the page under /fonts/.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FONTS_DIR = fileURLToPath(new URL("../fonts/", import.meta.url));

interface ManifestFile {
  readonly file: string;
  readonly subset: string;
  readonly unicodeRange?: string;
  readonly bytes: number;
}

export interface BundledFont {
  readonly id: string;
  readonly family: string;
  /** "100 900" for variable fonts, otherwise one weight. */
  readonly weight: string;
  readonly scripts: string;
  readonly license: string;
  readonly files: readonly ManifestFile[];
}

let manifest: readonly BundledFont[] | undefined;

export function bundledFonts(): readonly BundledFont[] {
  manifest ??= JSON.parse(readFileSync(join(FONTS_DIR, "manifest.json"), "utf8")) as BundledFont[];
  return manifest;
}

/** @font-face rules for every bundled font; `base` is the URL prefix the files are served under. */
export function fontFaceCss(base = "/fonts/"): string {
  const rules: string[] = [];
  for (const font of bundledFonts()) {
    for (const f of font.files) {
      rules.push(
        `@font-face{font-family:"${font.family}";font-style:normal;font-display:block;font-weight:${font.weight};` +
          `src:url("${base}${f.file}") format("woff2");${f.unicodeRange ? `unicode-range:${f.unicodeRange};` : ""}}`,
      );
    }
  }
  return rules.join("\n");
}

const cache = new Map<string, Buffer>();

/** Bytes of a bundled font file (by file name), or undefined if it isn't one. */
export function fontFile(name: string): Buffer | undefined {
  const file = basename(name);
  if (!bundledFonts().some((f) => f.files.some((x) => x.file === file))) return undefined;
  let bytes = cache.get(file);
  if (!bytes) {
    bytes = readFileSync(join(FONTS_DIR, "files", file));
    cache.set(file, bytes);
  }
  return bytes;
}
