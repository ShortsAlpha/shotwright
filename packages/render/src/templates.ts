/**
 * Screenshot templates. Each one turns its parameters into absolutely positioned HTML and CSS for a
 * W x H page; all geometry is computed here from the set size, so the only work left to the page is
 * caption fitting (shrink until the caption fits in `maxLines` lines, see renderer.ts).
 *
 * - `caption-top`: caption above, the whole framed device below.
 * - `bleed`: a larger device cut off by one edge. With `captionPosition: "top"` (default) the device
 *   bleeds off the bottom; with `"bottom"` the caption sits below and the device bleeds off the top.
 * - `panorama`: like caption-top, but the background and its shapes run across all `total`
 *   screenshots, each offset by its `index` (mirrored for right-to-left locales).
 */
import type { DeviceGeometry, FrameStyle } from "./frames.ts";
import { deviceHtml, frameOuterSize } from "./frames.ts";
import type { LocaleTypography } from "./locales.ts";
import type { DeviceColor } from "./frames.ts";

export type TemplateId = "caption-top" | "bleed" | "panorama";
export const TEMPLATE_IDS: readonly TemplateId[] = ["caption-top", "bleed", "panorama"];

export type ResolvedBackground =
  | { readonly kind: "solid"; readonly color: string }
  | { readonly kind: "gradient"; readonly from: string; readonly to: string; readonly angle: number }
  | { readonly kind: "image"; readonly url: string; readonly tint?: string };

export interface TemplateParams {
  readonly width: number;
  readonly height: number;
  readonly geometry: DeviceGeometry;
  readonly frame: FrameStyle;
  readonly deviceColor: DeviceColor;
  readonly captureUrl: string;
  /** Caption already converted to safe HTML (see captionHtml). */
  readonly captionHtml: string;
  readonly typography: LocaleTypography;
  readonly background: ResolvedBackground;
  readonly captionColor: string;
  readonly accent: string;
  /** 0-based position in the set and the set's length (panorama offsets, alternating layouts). */
  readonly index: number;
  readonly total: number;
  readonly captionPosition: "top" | "bottom";
  readonly maxLines: number;
  /** Device shadow strength 0..1. */
  readonly shadow: number;
}

export interface TemplateOutput {
  readonly html: string;
  readonly css: string;
}

const n = (v: number): string => (Math.round(v * 100) / 100).toString();

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Inserts <wbr> between words of a Chinese run (Intl.Segmenter, ICU dictionary). With
 * `word-break: keep-all` lines then break only between words, never inside one; no break is
 * offered before punctuation. Japanese uses the browser's `word-break: auto-phrase` instead.
 */
function segmentWords(run: string, locale: string): string {
  const segmenter = new Intl.Segmenter(locale, { granularity: "word" });
  let out = "";
  for (const seg of segmenter.segment(run)) {
    if (out && seg.isWordLike) out += "<wbr>";
    out += escapeHtml(seg.segment);
  }
  return out;
}

/**
 * Escapes a caption and turns `*emphasis*` into accent-colored spans and newlines into breaks.
 * Pass `segmentLocale` (zh-Hans / zh-Hant) to add word-boundary break opportunities.
 */
export function captionHtml(text: string, segmentLocale?: string): string {
  const run = (s: string) => (segmentLocale ? segmentWords(s, segmentLocale) : escapeHtml(s));
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) =>
      line
        .split(/(\*[^*]+\*)/)
        .map((part) => (/^\*[^*]+\*$/.test(part) ? `<span class="accent">${run(part.slice(1, -1))}</span>` : run(part)))
        .join(""),
    )
    .join("<br>");
}

/** Shared measurements for a W x H canvas. */
function metrics(p: TemplateParams) {
  const { width: W, height: H } = p;
  const tablet = p.geometry.kind === "tablet" || p.geometry.kind === "duo-inner";
  const base = 0.06 * Math.sqrt(W * H) * (tablet ? 0.92 : 1);
  const padX = W * (tablet ? 0.085 : 0.075);
  const lineH = base * p.typography.lineHeight;
  const capH = lineH * p.maxLines;
  const outer = frameOuterSize(p.geometry, p.frame);
  const aspect = outer.width / outer.height;
  return { W, H, tablet, base, padX, capH, aspect };
}

function backgroundHtml(bg: ResolvedBackground, left: number, width: number, height: number): string {
  const box = `position:absolute;left:${n(left)}px;top:0;width:${n(width)}px;height:${n(height)}px;`;
  switch (bg.kind) {
    case "solid":
      return `<div style="${box}background:${bg.color}"></div>`;
    case "gradient":
      return `<div style="${box}background:linear-gradient(${bg.angle}deg, ${bg.from}, ${bg.to})"></div>`;
    case "image":
      return (
        `<img src="${bg.url}" alt="" style="${box}object-fit:cover;display:block">` +
        (bg.tint ? `<div style="${box}background:${bg.tint}"></div>` : "")
      );
  }
}

function glowHtml(accent: string, cx: number, cy: number, rx: number, ry: number): string {
  return (
    `<div style="position:absolute;left:${n(cx - rx)}px;top:${n(cy - ry)}px;width:${n(rx * 2)}px;height:${n(ry * 2)}px;` +
    `background:radial-gradient(closest-side, color-mix(in srgb, ${accent} 42%, transparent), transparent)"></div>`
  );
}

function captionBox(p: TemplateParams, left: number, top: number, width: number, height: number, base: number): string {
  return (
    `<div class="cap-box" style="left:${n(left)}px;top:${n(top)}px;width:${n(width)}px;height:${n(height)}px">` +
    `<div class="cap" data-size="${n(base)}" data-min="${n(base * 0.5)}" data-lines="${p.maxLines}">${p.captionHtml}</div></div>`
  );
}

function css(p: TemplateParams): string {
  const t = p.typography;
  return (
    `html,body{margin:0;padding:0;width:${p.width}px;height:${p.height}px;overflow:hidden;background:#000}` +
    `#root{position:relative;width:${p.width}px;height:${p.height}px;overflow:hidden;background:#fff}` +
    `.cap-box{position:absolute;display:flex;align-items:center;justify-content:center}` +
    `.cap{margin:0;width:100%;text-align:center;color:${p.captionColor};font-family:${t.fontStack};` +
    `font-weight:${t.weight};line-height:${t.lineHeight};letter-spacing:${t.letterSpacing}em;` +
    `text-wrap:balance;overflow-wrap:normal;font-kerning:normal;${t.breaking}}` +
    `.cap .accent{color:${p.accent}}`
  );
}

function fullBleed(p: TemplateParams): TemplateOutput {
  return {
    css: css(p),
    html: `<img src="${p.captureUrl}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 0;display:block">`,
  };
}

function captionTop(p: TemplateParams): TemplateOutput {
  const m = metrics(p);
  const { W, H, padX, capH, base, aspect } = m;
  const capTop = H * 0.055;
  const devTop = capTop + capH + H * 0.035;
  const devBottom = H * 0.955;
  let devH = devBottom - devTop;
  let devW = devH * aspect;
  const maxW = W * (m.tablet ? 0.8 : 0.84);
  if (devW > maxW) {
    devW = maxW;
    devH = devW / aspect;
  }
  const left = (W - devW) / 2;
  const glow = p.background.kind === "image" ? "" : glowHtml(p.accent, W / 2, devTop + devH * 0.42, W * 0.62, devH * 0.42);
  return {
    css: css(p),
    html:
      backgroundHtml(p.background, 0, W, H) +
      glow +
      captionBox(p, padX, capTop, W - 2 * padX, capH, base) +
      deviceHtml(p.geometry, { captureUrl: p.captureUrl, style: frameStyle(p), color: p.deviceColor, shadow: p.shadow, width: devW, left, top: devTop }),
  };
}

function bleed(p: TemplateParams): TemplateOutput {
  const m = metrics(p);
  const { W, H, padX, capH, base, aspect } = m;
  const devW = W * (m.tablet ? 0.86 : 0.9);
  const devH = devW / aspect;
  /** At least this share of the device is cut off, so the bleed reads as intended. */
  const hidden = 0.16;
  const gap = H * 0.035;
  const edge = H * 0.05;
  let devTop: number;
  let capTop: number;
  if (p.captionPosition === "top") {
    devTop = Math.max(edge + capH + gap, H - devH * (1 - hidden));
    capTop = Math.max(edge * 0.8, (devTop - gap - capH) / 2 + edge * 0.25);
  } else {
    const devBottom = Math.min(H - edge - capH - gap, devH * (1 - hidden));
    devTop = devBottom - devH;
    capTop = devBottom + (H - devBottom - capH) / 2 - edge * 0.15;
  }
  const left = (W - devW) / 2;
  const glow = p.background.kind === "image" ? "" : glowHtml(p.accent, W / 2, devTop + devH / 2, W * 0.7, devH * 0.45);
  return {
    css: css(p),
    html:
      backgroundHtml(p.background, 0, W, H) +
      glow +
      deviceHtml(p.geometry, { captureUrl: p.captureUrl, style: frameStyle(p), color: p.deviceColor, shadow: p.shadow, width: devW, left, top: devTop }) +
      captionBox(p, padX, capTop, W - 2 * padX, capH, base),
  };
}

function panorama(p: TemplateParams): TemplateOutput {
  const m = metrics(p);
  const { W, H, padX, capH, base, aspect } = m;
  const total = Math.max(1, p.total);
  const slot = p.typography.dir === "rtl" ? total - 1 - p.index : p.index;
  const offset = slot * W;
  const span = total * W;
  // The strip behind all screenshots: a gradient running along it (so neighbours differ in shade
  // but meet seamlessly) and two ribbons that weave between the seams. Devices cover the middle
  // of each screenshot, so the ribbons show in the side margins, crossing from one screenshot
  // into the next.
  const bg: ResolvedBackground =
    p.background.kind === "gradient"
      ? {
          kind: "gradient",
          angle: 100,
          from: p.background.from,
          to: p.background.to,
        }
      : p.background;
  const stripBg =
    bg.kind === "gradient"
      ? `<div style="position:absolute;left:${n(-offset)}px;top:0;width:${n(span)}px;height:${n(H)}px;background:linear-gradient(100deg, ${Array.from(
          { length: Math.ceil(total / 2) + 1 },
          (_, i) => `${i % 2 === 0 ? bg.from : bg.to} ${n((i / Math.ceil(total / 2)) * 100)}%`,
        ).join(", ")})"></div>`
      : backgroundHtml(bg, -offset, span, H);
  const ribbon = (y0: number, y1: number, phase: number): string => {
    // Smooth curve through (k*W, y0|y1) alternating at every seam, tangents horizontal.
    let d = "";
    for (let k = -1; k <= total; k++) {
      const x = k * W;
      const y = (k + phase) % 2 === 0 ? y0 : y1;
      const yn = (k + 1 + phase) % 2 === 0 ? y0 : y1;
      if (!d) d = `M ${n(x)} ${n(y)}`;
      d += ` C ${n(x + W * 0.5)} ${n(y)}, ${n(x + W * 0.5)} ${n(yn)}, ${n(x + W)} ${n(yn)}`;
    }
    return d;
  };
  const shapes = [
    `<path d="${ribbon(H * 0.34, H * 0.72, 0)}" fill="none" stroke="${p.accent}" stroke-opacity="0.95" stroke-width="${n(W * 0.11)}" stroke-linecap="round"/>`,
    `<path d="${ribbon(H * 0.5, H * 0.86, 1)}" fill="none" stroke="${p.captionColor}" stroke-opacity="0.22" stroke-width="${n(W * 0.035)}" stroke-linecap="round"/>`,
  ];
  for (let k = 0; k <= total; k++) {
    shapes.push(`<circle cx="${n(k * W)}" cy="${n(H * (k % 2 ? 0.2 : 0.9))}" r="${n(W * 0.075)}" fill="${p.captionColor}" fill-opacity="0.12"/>`);
  }
  const strip =
    stripBg +
    `<svg width="${n(span)}" height="${n(H)}" viewBox="0 0 ${n(span)} ${n(H)}" style="position:absolute;left:${n(-offset)}px;top:0">${shapes.join("")}</svg>`;

  const capTop = H * 0.055;
  const devTop = capTop + capH + H * 0.04;
  let devH = H * 0.95 - devTop;
  let devW = devH * aspect;
  const maxW = W * (m.tablet ? 0.76 : 0.8);
  if (devW > maxW) {
    devW = maxW;
    devH = devW / aspect;
  }
  return {
    css: css(p),
    html:
      strip +
      captionBox(p, padX, capTop, W - 2 * padX, capH, base) +
      deviceHtml(p.geometry, { captureUrl: p.captureUrl, style: frameStyle(p), color: p.deviceColor, shadow: p.shadow, width: devW, left: (W - devW) / 2, top: devTop }),
  };
}

function frameStyle(p: TemplateParams): "device" | "none" {
  return p.frame === "none" ? "none" : "device";
}

export function buildTemplate(id: TemplateId, p: TemplateParams): TemplateOutput {
  if (p.frame === "full-bleed") return fullBleed(p);
  switch (id) {
    case "caption-top":
      return captionTop(p);
    case "bleed":
      return bleed(p);
    case "panorama":
      return panorama(p);
  }
}
