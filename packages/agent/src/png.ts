/** A tiny RGB canvas that encodes to PNG (8-bit, no alpha), for generated test frames. */
import { crc32, deflateSync, inflateSync } from "node:zlib";

export type Rgb = readonly [number, number, number];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Reads width and height from a PNG's IHDR chunk. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Not a PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export class Canvas {
  readonly width: number;
  readonly height: number;
  /** Raw PNG scanlines: one filter byte (0) followed by RGB triples per row. */
  private readonly data: Buffer;
  private readonly stride: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.stride = width * 3 + 1;
    this.data = Buffer.alloc(this.stride * height);
  }

  /** Fills row `y` with one colour. */
  fillRow(y: number, [r, g, b]: Rgb): void {
    const start = y * this.stride + 1;
    const end = start + this.width * 3;
    this.data[start] = r;
    this.data[start + 1] = g;
    this.data[start + 2] = b;
    for (let filled = 3; filled < end - start; filled *= 2) {
      this.data.copyWithin(start + filled, start, start + Math.min(filled, end - start - filled));
    }
  }

  private blend(x: number, y: number, [r, g, b]: Rgb, alpha: number): void {
    const i = y * this.stride + 1 + x * 3;
    if (alpha >= 1) {
      this.data[i] = r;
      this.data[i + 1] = g;
      this.data[i + 2] = b;
      return;
    }
    const keep = 1 - alpha;
    this.data[i] = r * alpha + this.data[i]! * keep;
    this.data[i + 1] = g * alpha + this.data[i + 1]! * keep;
    this.data[i + 2] = b * alpha + this.data[i + 2]! * keep;
  }

  /** Fills a rectangle with rounded corners (radius 0 for square corners). */
  fillRoundRect(x: number, y: number, w: number, h: number, radius: number, color: Rgb, alpha = 1): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    const r = Math.min(radius, w / 2, h / 2);
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        if (r > 0) {
          const dx = px < x + r ? x + r - px : px > x + w - r ? px - (x + w - r) : 0;
          const dy = py < y + r ? y + r - py : py > y + h - r ? py - (y + h - r) : 0;
          if (dx * dx + dy * dy > r * r) continue;
        }
        this.blend(px, py, color, alpha);
      }
    }
  }

  /** Fills a ring between `inner` and `outer` radius (inner 0 for a disc). */
  fillRing(cx: number, cy: number, inner: number, outer: number, color: Rgb, alpha = 1): void {
    const x0 = Math.max(0, Math.floor(cx - outer));
    const y0 = Math.max(0, Math.floor(cy - outer));
    const x1 = Math.min(this.width, Math.ceil(cx + outer));
    const y1 = Math.min(this.height, Math.ceil(cy + outer));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const d2 = (px - cx) ** 2 + (py - cy) ** 2;
        if (d2 <= outer * outer && d2 >= inner * inner) this.blend(px, py, color, alpha);
      }
    }
  }

  toPng(): Buffer {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(this.width, 0);
    header.writeUInt32BE(this.height, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // colour type: RGB
    return Buffer.concat([
      PNG_SIGNATURE,
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(this.data, { level: 1 })),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
}

/** HSL (h in degrees, s and l in 0..1) to RGB. */
export function hsl(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [f(0), f(8), f(4)];
}

/**
 * Decodes an 8-bit, non-interlaced PNG (grey, grey+alpha, RGB or RGBA; what simctl and Xcode write)
 * into unfiltered scanlines. Enough to inspect pixels without an image library.
 */
export function decodePng(png: Uint8Array): { width: number; height: number; channels: number; pixels: Buffer } {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  const { width, height } = pngSize(buf);
  const depth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (depth !== 8 || channels === 0 || interlace !== 0) {
    throw new Error(`Unsupported PNG (bit depth ${depth}, colour type ${colorType}, interlace ${interlace})`);
  }
  const idat: Buffer[] = [];
  for (let offset = 8; offset + 8 <= buf.length; ) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(buf.subarray(offset + 8, offset + 8 + length));
    if (type === "IEND") break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    const prev = out - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[out + x - channels]! : 0;
      const b = y > 0 ? pixels[prev + x]! : 0;
      const c = y > 0 && x >= channels ? pixels[prev + x - channels]! : 0;
      let value = line[x]!;
      switch (filter) {
        case 1:
          value += a;
          break;
        case 2:
          value += b;
          break;
        case 3:
          value += (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
      }
      pixels[out + x] = value & 255;
    }
  }
  return { width, height, channels, pixels };
}

/**
 * Share of pixels (0..1) brighter than `threshold` in any colour channel, sampled on a grid of
 * every `step`-th pixel. Transparent pixels count as black.
 */
export function litShare(png: Uint8Array, threshold = 24, step = 4): number {
  const { width, height, channels, pixels } = decodePng(png);
  let lit = 0;
  let total = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * channels;
      total++;
      if ((channels === 2 || channels === 4) && pixels[i + channels - 1]! < 16) continue;
      const colour = channels >= 3 ? Math.max(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) : pixels[i]!;
      if (colour > threshold) lit++;
    }
  }
  return total === 0 ? 0 : lit / total;
}
