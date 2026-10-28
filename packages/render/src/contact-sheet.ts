/**
 * Contact sheet: a grid of thumbnails (any sizes) for reviewing a render, as JPEG or PNG bytes.
 */
import sharp, { type OverlayOptions } from "sharp";

export interface SheetImage {
  readonly image: Uint8Array | string;
  readonly label?: string;
}

export interface ContactSheetOptions {
  readonly columns: number;
  /** Thumbnail height in px. Default 640. */
  readonly thumbHeight?: number;
  readonly gap?: number;
  readonly background?: string;
  readonly format?: "jpeg" | "png";
  readonly title?: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function contactSheet(images: readonly SheetImage[], o: ContactSheetOptions): Promise<Buffer> {
  const h = o.thumbHeight ?? 640;
  const gap = o.gap ?? 24;
  const labelH = images.some((i) => i.label) ? Math.round(h * 0.06) + 8 : 0;
  const titleH = o.title ? Math.round(h * 0.09) + gap : 0;
  const thumbs = await Promise.all(
    images.map(async (i) => {
      const buf = await sharp(i.image).resize({ height: h }).png().toBuffer();
      const { width } = await sharp(buf).metadata();
      return { buf, width: width ?? h, label: i.label };
    }),
  );
  const cellW = Math.max(...thumbs.map((t) => t.width));
  const rows = Math.ceil(thumbs.length / o.columns);
  const W = gap + o.columns * (cellW + gap);
  const H = titleH + gap + rows * (h + labelH + gap);
  const layers: OverlayOptions[] = [];
  const text: string[] = [];
  const fs = Math.round(h * 0.035);
  if (o.title) {
    text.push(`<text x="${gap}" y="${gap + Math.round(h * 0.06)}" font-size="${Math.round(h * 0.05)}" font-weight="700">${esc(o.title)}</text>`);
  }
  thumbs.forEach((t, i) => {
    const col = i % o.columns;
    const row = Math.floor(i / o.columns);
    const x = gap + col * (cellW + gap) + Math.round((cellW - t.width) / 2);
    const y = titleH + gap + row * (h + labelH + gap);
    layers.push({ input: t.buf, left: x, top: y });
    if (t.label) {
      // Shrink long labels to the cell width (average glyph ~0.55 em).
      const size = Math.min(fs, Math.floor(cellW / (t.label.length * 0.55)));
      text.push(`<text x="${x + t.width / 2}" y="${y + h + fs + 6}" font-size="${size}" text-anchor="middle">${esc(t.label)}</text>`);
    }
  });
  if (text.length) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><g font-family="Helvetica, Arial, sans-serif" fill="#e5e7eb">${text.join("")}</g></svg>`;
    layers.push({ input: Buffer.from(svg), left: 0, top: 0 });
  }
  const img = sharp({ create: { width: W, height: H, channels: 3, background: o.background ?? "#111317" } }).composite(layers);
  return o.format === "png" ? img.png().toBuffer() : img.jpeg({ quality: 86 }).toBuffer();
}
