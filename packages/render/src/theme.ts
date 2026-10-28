/**
 * Themes: background, caption and accent colors, optional custom font.
 * `themeFromIcon` derives one from the app icon so the site can prefill a brand theme.
 */
import sharp from "sharp";
import type { DeviceColor } from "./frames.ts";

export type Background =
  | { readonly kind: "solid"; readonly color: string }
  /** Linear gradient; `angle` in CSS degrees (180 = top to bottom). */
  | { readonly kind: "gradient"; readonly from: string; readonly to: string; readonly angle?: number }
  /** Image (path, URL or bytes) covering the screenshot, e.g. a Muse Image background. `tint` is laid over it. */
  | { readonly kind: "image"; readonly src: string | Uint8Array; readonly tint?: string };

export interface ThemeFont {
  /** CSS family name; with `src` it is registered from that file, otherwise it must be a bundled family. */
  readonly family: string;
  readonly src?: string | Uint8Array;
  readonly weight?: number;
}

export interface Theme {
  readonly background: Background;
  readonly captionColor: string;
  /** Used for `*emphasis*` in captions, glows and panorama shapes. */
  readonly accent: string;
  /** Overrides the locale's font for scripts it covers; the locale's font stays as a fallback. */
  readonly font?: ThemeFont;
  readonly deviceColor?: DeviceColor;
}

export const DEFAULT_THEME: Theme = {
  background: { kind: "gradient", from: "#1d4ed8", to: "#0b1f5c", angle: 165 },
  captionColor: "#ffffff",
  accent: "#fbbf24",
  deviceColor: "dark",
};

// --- Color helpers -----------------------------------------------------------

export type Rgb = readonly [number, number, number];

export function parseHex(hex: string): Rgb {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h.slice(0, 6);
  const v = Number.parseInt(full, 16);
  if (!/^[0-9a-f]{6}$/i.test(full) || Number.isNaN(v)) throw new Error(`Not a hex color: ${hex}`);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function toHex([r, g, b]: Rgb): string {
  const c = (x: number) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Mixes `a` toward `b` by t (0..1). */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = parseHex(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function hsl([r, g, b]: Rgb): { h: number; s: number; l: number } {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

function distance(a: Rgb, b: Rgb): number {
  // "Redmean" approximation of perceptual distance.
  const rm = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

/** Color distance that treats tints and shades of one hue as close (they read as one brand color). */
function distinctness(a: Rgb, b: Rgb): number {
  const d = distance(a, b);
  const x = hsl(a);
  const y = hsl(b);
  const chromatic = (c: { s: number; l: number }) => c.s > 0.2 && c.l > 0.1 && c.l < 0.92;
  if (!chromatic(x) || !chromatic(y)) return d;
  const dh = Math.min(Math.abs(x.h - y.h), 360 - Math.abs(x.h - y.h));
  return dh < 35 ? d * 0.35 : d;
}

// --- Icon colors -------------------------------------------------------------

export interface IconColor {
  readonly hex: string;
  /** Share of the icon's opaque pixels. */
  readonly share: number;
  readonly saturation: number;
  readonly lightness: number;
}

/** The `count` most common distinct colors of an icon (PNG/JPEG bytes or path), most common first. */
export async function dominantColors(icon: Uint8Array | string, count = 3): Promise<IconColor[]> {
  const { data, info } = await sharp(icon)
    .resize(96, 96, { fit: "cover" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    const o = i * 4;
    if (data[o + 3]! < 160) continue;
    const r = data[o]!;
    const g = data[o + 1]!;
    const b = data[o + 2]!;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bin.n++;
    bin.r += r;
    bin.g += g;
    bin.b += b;
    bins.set(key, bin);
    total++;
  }
  const sorted = [...bins.values()].sort((a, b) => b.n - a.n);
  // Merge neighbouring bins into clusters around the most common ones.
  const clusters: { rgb: Rgb; n: number }[] = [];
  for (const bin of sorted) {
    const rgb: Rgb = [bin.r / bin.n, bin.g / bin.n, bin.b / bin.n];
    const near = clusters.find((c) => distance(c.rgb, rgb) < 90);
    if (near) near.n += bin.n;
    else clusters.push({ rgb, n: bin.n });
  }
  // Most common cluster first, then the ones that are both common and different from those
  // already picked (so a small orange dot beats a second shade of the main blue).
  const candidates = clusters.filter((c) => c.n / total >= 0.0015).sort((a, b) => b.n - a.n);
  const picked = candidates.splice(0, 1);
  while (picked.length < count && candidates.length) {
    let best = 0;
    let bestScore = -1;
    candidates.forEach((c, i) => {
      const minDist = Math.min(...picked.map((p) => distinctness(p.rgb, c.rgb)));
      const score = Math.sqrt(c.n / total) * (minDist / 765) ** 2;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    picked.push(...candidates.splice(best, 1));
  }
  return picked.map((c) => {
    const { s, l } = hsl(c.rgb);
    return { hex: toHex(c.rgb), share: c.n / total, saturation: s, lightness: l };
  });
}

export interface IconTheme {
  readonly colors: readonly IconColor[];
  readonly theme: Theme;
}

/**
 * A theme from the app icon: the most prominent saturated color becomes the background
 * (a gradient, dark mode) or a pale tint of it (light mode); a second distinct color becomes the accent.
 */
export async function themeFromIcon(icon: Uint8Array | string, mode: "dark" | "light" = "dark"): Promise<IconTheme> {
  const colors = await dominantColors(icon, 4);
  const chromatic = colors.filter((c) => c.saturation > 0.25 && c.lightness > 0.12 && c.lightness < 0.88);
  const brand = chromatic[0]?.hex ?? colors[0]?.hex ?? "#2563eb";
  const second = chromatic.find((c) => c.hex !== brand && distance(parseHex(c.hex), parseHex(brand)) > 150)?.hex;
  if (mode === "dark") {
    // Keep the brand color recognisable but dark enough for white text.
    let top = brand;
    while (contrast(top, "#ffffff") < 4.5 && luminance(top) > 0.02) top = mix(top, "#000000", 0.08);
    const bottom = mix(top, "#000000", 0.45);
    const accent = second && contrast(second, bottom) >= 3 ? second : mix(brand, "#ffffff", 0.55);
    return {
      colors,
      theme: { background: { kind: "gradient", from: top, to: bottom, angle: 170 }, captionColor: "#ffffff", accent, deviceColor: "dark" },
    };
  }
  const top = mix(brand, "#ffffff", 0.9);
  const bottom = mix(brand, "#ffffff", 0.75);
  let caption = mix(brand, "#000000", 0.7);
  while (contrast(caption, bottom) < 7 && luminance(caption) > 0.005) caption = mix(caption, "#000000", 0.15);
  let accent = brand;
  while (contrast(accent, top) < 3 && luminance(accent) > 0.02) accent = mix(accent, "#000000", 0.1);
  return {
    colors,
    theme: { background: { kind: "gradient", from: top, to: bottom, angle: 180 }, captionColor: caption, accent, deviceColor: "dark" },
  };
}
