/**
 * Our own device frames, drawn as SVG from a few proportions of the screen size.
 * Deliberately generic (a rounded slab, a Dynamic Island, side buttons) so they are not
 * Apple's marketing bezels; nothing here is traced from Apple artwork.
 *
 * Geometry is in screen pixels of the device's native capture (= the set's portrait size):
 *
 *   ┌ depth ┬ band ┬ bezel ┬─────── screen ───────┐
 *   button   metal  black    capture, clipped to screenRadius
 *
 * The capture is an <img> inside a div with border-radius = screenRadius (scaled), layered
 * between the body SVG (buttons, metal band, black bezel) and an overlay SVG (island, camera hole).
 */
import { SCREENSHOT_SETS, type PixelSize, type ScreenshotSetId } from "@shotwright/core";

export type DeviceKind = "phone" | "tablet" | "duo-outer" | "duo-inner";

/**
 * - `device`: our SVG frame around the capture
 * - `none`: no frame; the capture with the device's screen corners and a soft shadow
 * - `full-bleed`: the capture alone, scaled to cover the whole screenshot (no caption, no background)
 */
export type FrameStyle = "device" | "none" | "full-bleed";
export type DeviceColor = "dark" | "light";

export interface DeviceButton {
  readonly side: "left" | "right" | "top";
  /** Fractions of the screen height (left/right) or width (top), from the screen's top/left edge. */
  readonly start: number;
  readonly end: number;
}

export interface DeviceGeometry {
  readonly kind: DeviceKind;
  readonly screen: PixelSize;
  /** Metal edge. */
  readonly band: number;
  /** Black glass border between band and screen. */
  readonly bezel: number;
  readonly screenRadius: number;
  /** How far buttons stick out; also the margin around the body in the SVG. */
  readonly depth: number;
  /** Dynamic Island, centered, `top` from the screen's top edge. */
  readonly island?: { readonly width: number; readonly height: number; readonly top: number };
  /** Hole-punch camera in screen coordinates (Duo outer display). */
  readonly hole?: { readonly cx: number; readonly cy: number; readonly d: number };
  /** Camera dot centered in the top bezel. */
  readonly bezelCamera?: { readonly r: number };
  /** Fold line in screen coordinates (Duo inner display, portrait). */
  readonly hingeY?: number;
  readonly buttons: readonly DeviceButton[];
}

export function deviceKind(set: ScreenshotSetId): DeviceKind {
  switch (set) {
    case "iphone-6.3":
      return "phone";
    case "ipad-13":
      return "tablet";
    case "iphone-duo-outer":
      return "duo-outer";
    case "iphone-duo-inner":
      return "duo-inner";
  }
}

/** Frame geometry for a set, scaled from its portrait pixel size. */
export function deviceGeometry(set: ScreenshotSetId): DeviceGeometry {
  const screen = SCREENSHOT_SETS[set].portrait;
  const w = screen.width;
  const kind = deviceKind(set);
  switch (kind) {
    case "phone":
      // Island 126 x 37.3 pt, 11 pt from the top on a 402 pt wide screen; display corner ~62 pt.
      return {
        kind,
        screen,
        band: w * 0.0125,
        bezel: w * 0.03,
        screenRadius: w * 0.154,
        depth: w * 0.011,
        island: { width: w * 0.313, height: w * 0.0928, top: w * 0.0274 },
        buttons: [
          { side: "left", start: 0.165, end: 0.205 },
          { side: "left", start: 0.255, end: 0.33 },
          { side: "left", start: 0.36, end: 0.435 },
          { side: "right", start: 0.27, end: 0.385 },
          { side: "right", start: 0.585, end: 0.655 },
        ],
      };
    case "tablet":
      return {
        kind,
        screen,
        band: w * 0.0065,
        bezel: w * 0.042,
        screenRadius: w * 0.03,
        depth: w * 0.006,
        bezelCamera: { r: w * 0.0048 },
        buttons: [
          { side: "top", start: 0.78, end: 0.87 },
          { side: "right", start: 0.07, end: 0.125 },
          { side: "right", start: 0.14, end: 0.195 },
        ],
      };
    case "duo-outer":
      // Hole measured on Simulator captures of the outer display: center (1254, 143), 110 px, of 1398 px width.
      return {
        kind,
        screen,
        band: w * 0.0125,
        bezel: w * 0.03,
        screenRadius: w * 0.125,
        depth: w * 0.011,
        hole: { cx: w * (1254 / 1398), cy: w * (143 / 1398), d: w * (110 / 1398) },
        buttons: [
          { side: "right", start: 0.2, end: 0.31 },
          { side: "right", start: 0.36, end: 0.5 },
        ],
      };
    case "duo-inner":
      return {
        kind,
        screen,
        band: w * 0.009,
        bezel: w * 0.02,
        screenRadius: w * 0.05,
        depth: w * 0.008,
        hingeY: screen.height / 2,
        buttons: [
          { side: "right", start: 0.06, end: 0.13 },
          { side: "right", start: 0.16, end: 0.27 },
        ],
      };
  }
}

/** Size of the whole frame (body plus button margin) in screen pixels. */
export function frameOuterSize(g: DeviceGeometry, style: FrameStyle): PixelSize {
  if (style !== "device") return g.screen;
  const m = 2 * (g.band + g.bezel + g.depth);
  return { width: g.screen.width + m, height: g.screen.height + m };
}

/** Screen rectangle inside the frame, in screen pixels (for layout, e.g. where the island is). */
export function screenOffset(g: DeviceGeometry, style: FrameStyle): number {
  return style === "device" ? g.depth + g.band + g.bezel : 0;
}

const PALETTE = {
  dark: {
    bodyTop: "#4a4a4f",
    bodyMid: "#2b2b2f",
    bodyBottom: "#46464b",
    highlight: "rgba(255,255,255,0.30)",
    edge: "rgba(0,0,0,0.55)",
    button: "#34343a",
  },
  light: {
    bodyTop: "#ececf0",
    bodyMid: "#cfcfd5",
    bodyBottom: "#e6e6ea",
    highlight: "rgba(255,255,255,0.95)",
    edge: "rgba(0,0,0,0.28)",
    button: "#c4c4ca",
  },
} as const;

let uid = 0;
const n = (v: number): string => (Math.round(v * 100) / 100).toString();

export interface DeviceHtmlOptions {
  /** URL of the capture (served to the page). */
  readonly captureUrl: string;
  readonly style: Exclude<FrameStyle, "full-bleed">;
  readonly color?: DeviceColor;
  /** Rendered width of the whole frame in CSS px; height follows the frame's aspect ratio. */
  readonly width: number;
  readonly left: number;
  readonly top: number;
  /** Shadow strength 0..1 (0 = none). */
  readonly shadow?: number;
  /** Extra inline CSS for the wrapper (e.g. a transform). */
  readonly css?: string;
}

/** HTML for a framed (or frameless) device at an absolute position. */
export function deviceHtml(g: DeviceGeometry, o: DeviceHtmlOptions): string {
  const outer = frameOuterSize(g, o.style);
  const k = o.width / outer.width;
  const height = outer.height * k;
  const inset = screenOffset(g, o.style);
  const shadow = o.shadow ?? 0.35;
  const blur = o.width * 0.05;
  // Shadows are box-shadows on rounded rectangles (Skia draws those analytically), not
  // `filter: drop-shadow`, which blurs the whole rasterized device and costs ~3x more on big sets.
  const shadowCss = shadow > 0 ? `box-shadow:0 ${n(blur * 0.45)}px ${n(blur * 1.6)}px rgba(0,0,0,${n(shadow)});` : "";
  const screen =
    `<div style="position:absolute;left:${n(inset * k)}px;top:${n(inset * k)}px;width:${n(g.screen.width * k)}px;` +
    `height:${n(g.screen.height * k)}px;border-radius:${n(g.screenRadius * k)}px;overflow:hidden;background:#000;` +
    (o.style === "none" ? shadowCss : "") +
    `"><img src="${o.captureUrl}" alt="" style="display:block;width:100%;height:100%;object-fit:cover;object-position:50% 0"></div>`;
  const wrapper = `position:absolute;left:${n(o.left)}px;top:${n(o.top)}px;width:${n(o.width)}px;height:${n(height)}px;${o.css ?? ""}`;
  if (o.style === "none") return `<div class="device" style="${wrapper}">${screen}</div>`;
  const bodyRadius = (g.screenRadius + g.band + g.bezel) * k;
  const body = shadowCss
    ? `<div style="position:absolute;left:${n(g.depth * k)}px;top:${n(g.depth * k)}px;width:${n((outer.width - 2 * g.depth) * k)}px;` +
      `height:${n((outer.height - 2 * g.depth) * k)}px;border-radius:${n(bodyRadius)}px;${shadowCss}"></div>`
    : "";
  const viewBox = `0 0 ${n(outer.width)} ${n(outer.height)}`;
  const svgAttrs = `viewBox="${viewBox}" width="${n(o.width)}" height="${n(height)}" style="position:absolute;left:0;top:0"`;
  return (
    `<div class="device" style="${wrapper}">` +
    body +
    `<svg ${svgAttrs}>${bodySvg(g, o.color ?? "dark")}</svg>` +
    screen +
    `<svg ${svgAttrs}>${overlaySvg(g)}</svg>` +
    `</div>`
  );
}

function bodySvg(g: DeviceGeometry, color: DeviceColor): string {
  const p = PALETTE[color];
  const id = `f${++uid}`;
  const { band, bezel, depth } = g;
  const bw = g.screen.width + 2 * (band + bezel);
  const bh = g.screen.height + 2 * (band + bezel);
  const R = g.screenRadius + band + bezel;
  const parts: string[] = [];
  parts.push(
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="${p.bodyTop}"/><stop offset="0.5" stop-color="${p.bodyMid}"/>` +
      `<stop offset="1" stop-color="${p.bodyBottom}"/></linearGradient></defs>`,
  );
  // Buttons: drawn first, overlapping the body by `depth` so no seam shows.
  for (const b of g.buttons) {
    const thick = depth * 2;
    if (b.side === "top") {
      const x = depth + band + bezel + b.start * g.screen.width;
      const len = (b.end - b.start) * g.screen.width;
      parts.push(`<rect x="${n(x)}" y="0" width="${n(len)}" height="${n(thick)}" rx="${n(depth * 0.8)}" fill="${p.button}"/>`);
    } else {
      const y = depth + band + bezel + b.start * g.screen.height;
      const len = (b.end - b.start) * g.screen.height;
      const x = b.side === "left" ? 0 : depth + bw - depth;
      parts.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(thick)}" height="${n(len)}" rx="${n(depth * 0.8)}" fill="${p.button}"/>`);
    }
  }
  // Metal body, its highlight and silhouette edge.
  parts.push(`<rect x="${n(depth)}" y="${n(depth)}" width="${n(bw)}" height="${n(bh)}" rx="${n(R)}" fill="url(#${id})"/>`);
  const hs = band * 0.32;
  parts.push(
    `<rect x="${n(depth + band * 0.28 + hs / 2)}" y="${n(depth + band * 0.28 + hs / 2)}" width="${n(bw - band * 0.56 - hs)}" ` +
      `height="${n(bh - band * 0.56 - hs)}" rx="${n(R - band * 0.28 - hs / 2)}" fill="none" stroke="${p.highlight}" stroke-width="${n(hs)}"/>`,
  );
  const es = Math.max(band * 0.14, 1);
  parts.push(
    `<rect x="${n(depth + es / 2)}" y="${n(depth + es / 2)}" width="${n(bw - es)}" height="${n(bh - es)}" rx="${n(R - es / 2)}" ` +
      `fill="none" stroke="${p.edge}" stroke-width="${n(es)}"/>`,
  );
  // Hinge (Duo inner): a dark seam across the metal band on both sides.
  if (g.hingeY !== undefined) {
    const y = depth + band + bezel + g.hingeY;
    const hh = band * 0.9;
    for (const x of [depth, depth + bw - band]) {
      parts.push(`<rect x="${n(x)}" y="${n(y - hh / 2)}" width="${n(band)}" height="${n(hh)}" fill="rgba(0,0,0,0.55)"/>`);
    }
  }
  // Black glass border.
  parts.push(
    `<rect x="${n(depth + band)}" y="${n(depth + band)}" width="${n(bw - 2 * band)}" height="${n(bh - 2 * band)}" rx="${n(R - band)}" fill="#030304"/>`,
  );
  if (g.bezelCamera) {
    const cx = depth + bw / 2;
    const cy = depth + band + bezel / 2;
    const r = g.bezelCamera.r;
    parts.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="#16161a"/>`);
    parts.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 0.45)}" fill="#26283a"/>`);
  }
  return parts.join("");
}

function overlaySvg(g: DeviceGeometry): string {
  const off = g.depth + g.band + g.bezel;
  const parts: string[] = [];
  if (g.island) {
    const { width, height, top } = g.island;
    const x = off + (g.screen.width - width) / 2;
    parts.push(`<rect x="${n(x)}" y="${n(off + top)}" width="${n(width)}" height="${n(height)}" rx="${n(height / 2)}" fill="#000"/>`);
    // Front camera lens, a hint inside the island.
    const r = height * 0.2;
    parts.push(`<circle cx="${n(x + width - height / 2)}" cy="${n(off + top + height / 2)}" r="${n(r)}" fill="#0b0c14"/>`);
  }
  if (g.hole) {
    const { cx, cy, d } = g.hole;
    parts.push(`<circle cx="${n(off + cx)}" cy="${n(off + cy)}" r="${n(d / 2)}" fill="#000"/>`);
    parts.push(`<circle cx="${n(off + cx)}" cy="${n(off + cy)}" r="${n(d * 0.2)}" fill="#0b0c14"/>`);
  }
  return parts.join("");
}
