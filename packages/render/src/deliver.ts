/**
 * Export in the fastlane `deliver` layout, and a dependency-free zip writer.
 *
 *   <outDir>/screenshots/<asc-locale>/<nn>_<setLabel>_<screen>.png
 *
 * `deliver` reads the locale from the folder name, the display type from the pixel size, and the
 * order from the file names (sorted), hence the zero-padded position first.
 */
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import type { ScreenshotSetId } from "@shotwright/core";
import { toAscLocale } from "./locales.ts";

/**
 * File-name label per set. `ipadPro129` is the marker fastlane uses to tell 12.9"/13" iPad Pro
 * screenshots from older 12.9" ones of a similar size.
 */
export const SET_FILE_LABELS: Readonly<Record<ScreenshotSetId, string>> = {
  "iphone-6.3": "iPhone63",
  "ipad-13": "ipadPro129",
  "iphone-duo-outer": "iPhoneDuoOuter",
  "iphone-duo-inner": "iPhoneDuoInner",
};

export interface DeliverItem {
  /** Our locale (`en`, `de`, `pt-BR`, …) or an App Store Connect code; mapped with toAscLocale. */
  readonly locale: string;
  readonly set: ScreenshotSetId;
  /** Screen name, e.g. `home-overview`. */
  readonly screen: string;
  /** 1-based position within the set (App Store order). */
  readonly position: number;
  readonly bytes: Uint8Array;
  readonly format?: "png" | "jpeg";
}

export interface DeliverResult {
  readonly root: string;
  /** Paths relative to `root`. */
  readonly files: readonly string[];
}

function slug(s: string): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "screen"
  );
}

export function deliverPath(item: Omit<DeliverItem, "bytes">): string {
  const ext = item.format === "jpeg" ? "jpg" : "png";
  const name = `${String(item.position).padStart(2, "0")}_${SET_FILE_LABELS[item.set]}_${slug(item.screen)}.${ext}`;
  return join("screenshots", toAscLocale(item.locale), name);
}

/** Writes items into `<outDir>/screenshots/<asc-locale>/…`. With `clean`, removes an existing screenshots/ first. */
export async function writeDeliverFolder(outDir: string, items: readonly DeliverItem[], options: { clean?: boolean } = {}): Promise<DeliverResult> {
  if (options.clean) rmSync(join(outDir, "screenshots"), { recursive: true, force: true });
  const seen = new Set<string>();
  const files: string[] = [];
  for (const item of items) {
    const rel = deliverPath(item);
    if (seen.has(rel)) throw new Error(`Duplicate deliver path ${rel}`);
    seen.add(rel);
    const abs = join(outDir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    await writeFile(abs, item.bytes);
    files.push(rel);
  }
  return { root: outDir, files };
}

// --- Zip ---------------------------------------------------------------------

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === ".DS_Store") continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs));
    else out.push(abs);
  }
  return out;
}

function dosDateTime(d: Date): { date: number; time: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Zips every file under `dir` into `outFile` (entries relative to `dir`, forward slashes,
 * under `prefix/` if given). PNG/JPEG/MP4 are stored (already compressed), everything else is
 * deflated. No ZIP64: throws past 4 GiB or 65,535 entries.
 *
 *   zipDirectory(join(out, "screenshots"), join(out, "screenshots.zip"), { prefix: "screenshots" })
 */
export function zipDirectory(dir: string, outFile: string, options: { prefix?: string } = {}): { entries: number; bytes: number } {
  const files = listFiles(dir).filter((f) => resolve(f) !== resolve(outFile));
  if (files.length > 0xffff) throw new Error("Too many files for a zip without ZIP64");
  const fd = openSync(outFile, "w");
  const central: Buffer[] = [];
  let offset = 0;
  const write = (b: Buffer) => {
    writeSync(fd, b);
    offset += b.length;
  };
  try {
    for (const abs of files) {
      const relName = relative(dir, abs).split(sep).join("/");
      const name = Buffer.from(options.prefix ? `${options.prefix.replace(/\/+$/, "")}/${relName}` : relName, "utf8");
      const raw = readFileSync(abs);
      const store = /\.(png|jpe?g|mp4|mov|zip)$/i.test(abs);
      const data = store ? raw : deflateRawSync(raw);
      const method = store ? 0 : 8;
      const crc = crc32(raw) >>> 0;
      const { date, time } = dosDateTime(statSync(abs).mtime);
      if (offset + data.length > 0xfffffff0) throw new Error("Zip would exceed 4 GiB (no ZIP64 support)");
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      const headerOffset = offset;
      write(local);
      write(name);
      write(data);
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(0x031e, 4); // made by: Unix, 3.0
      entry.writeUInt16LE(20, 6);
      entry.writeUInt16LE(0x0800, 8);
      entry.writeUInt16LE(method, 10);
      entry.writeUInt16LE(time, 12);
      entry.writeUInt16LE(date, 14);
      entry.writeUInt32LE(crc, 16);
      entry.writeUInt32LE(data.length, 20);
      entry.writeUInt32LE(raw.length, 24);
      entry.writeUInt16LE(name.length, 28);
      entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
      entry.writeUInt32LE(headerOffset, 42);
      central.push(entry, name);
    }
    const cdOffset = offset;
    const cd = Buffer.concat(central);
    write(cd);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(cdOffset, 16);
    write(end);
  } finally {
    closeSync(fd);
  }
  return { entries: files.length, bytes: offset };
}
