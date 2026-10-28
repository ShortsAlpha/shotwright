/**
 * Rendering engine: one headless Chromium (Playwright), a small pool of pages that each load a
 * shell document once (fonts included), then render every screenshot by swapping the DOM, fitting
 * captions in the page, and screenshotting the viewport at the set's exact pixel size.
 * The PNG is re-encoded with sharp without an alpha channel (App Store Connect rejects alpha).
 *
 * Nothing touches the network: the shell, fonts, captures and background images are served to the
 * page from memory through a Playwright route on a private origin.
 */
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { SCREENSHOT_SETS, type ScreenshotSetId } from "@shotwright/core";
import { chromium, type Browser, type BrowserContext, type CDPSession, type LaunchOptions, type Page, type Route } from "playwright";
import sharp from "sharp";
import { fontFaceCss, fontFile } from "./fonts.ts";
import { deviceGeometry, type FrameStyle } from "./frames.ts";
import { localeTypography } from "./locales.ts";
import { buildTemplate, captionHtml, type ResolvedBackground, type TemplateId } from "./templates.ts";
import { DEFAULT_THEME, type Theme } from "./theme.ts";

const ORIGIN = "https://render.shotwright.invalid";

export interface RenderJob {
  readonly set: ScreenshotSetId;
  /** Default `caption-top`. */
  readonly template?: TemplateId;
  /** PNG/JPEG bytes or a file path. Any size: it is scaled to cover the device screen, anchored at the top. */
  readonly capture: Uint8Array | string;
  readonly caption?: string;
  /** BCP 47 locale (`en`, `de`, `ja`, `ar`, `zh-Hant`); picks font, direction and line breaking. Default `en`. */
  readonly locale?: string;
  readonly theme?: Theme;
  /** 0-based position in the set and the number of screenshots in it (panorama). */
  readonly index?: number;
  readonly total?: number;
  /** Default `device`. */
  readonly frame?: FrameStyle;
  /** `bleed` only. Default `top`. */
  readonly captionPosition?: "top" | "bottom";
  /** Default 2. */
  readonly maxLines?: number;
  /** Default `png`. */
  readonly format?: "png" | "jpeg";
  readonly jpegQuality?: number;
  /** Device shadow strength 0..1. Default 0.35. */
  readonly shadow?: number;
}

export interface CaptionFit {
  readonly fontSize: number;
  readonly baseSize: number;
  readonly lines: number;
  readonly fits: boolean;
}

export interface RenderResult {
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
  readonly format: "png" | "jpeg";
  readonly caption?: CaptionFit;
  readonly warnings: readonly string[];
  /** Wall-clock milliseconds: DOM + fonts + images + caption fit, Chromium screenshot, sharp re-encode. */
  readonly ms: { readonly total: number; readonly layout: number; readonly screenshot: number; readonly encode: number };
}

export interface RendererOptions {
  /** Pages rendering in parallel. Default 2 (fine on an 8 GB machine). */
  readonly concurrency?: number;
  /** Passed to chromium.launch (e.g. executablePath, extra args). */
  readonly launch?: LaunchOptions;
}

export interface Renderer {
  render(job: RenderJob): Promise<RenderResult>;
  /** Renders in order of `jobs` using all pages; results keep the order. */
  renderMany(jobs: readonly RenderJob[], onDone?: (index: number, result: RenderResult) => void): Promise<RenderResult[]>;
  close(): Promise<void>;
}

interface Asset {
  readonly body: Buffer;
  readonly contentType: string;
}

function sniff(bytes: Buffer): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF") return "image/webp";
  if (bytes.subarray(0, 4).toString("latin1") === "wOF2") return "font/woff2";
  if (bytes.subarray(0, 4).toString("latin1") === "OTTO" || bytes.readUInt32BE(0) === 0x10000) return "font/ttf";
  return "application/octet-stream";
}

async function bytesOf(src: Uint8Array | string): Promise<Buffer> {
  return typeof src === "string" ? readFile(src) : Buffer.from(src.buffer, src.byteOffset, src.byteLength);
}

const SHELL = (): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${fontFaceCss("/fonts/")}</style>` +
  `<style id="tpl"></style></head><body><div id="root"></div></body></html>`;

interface PageArgs {
  readonly html: string;
  readonly css: string;
  readonly lang: string;
  readonly dir: string;
  readonly font: string;
  readonly text: string;
}

interface PageResult {
  readonly captions: { fontSize: number; baseSize: number; lines: number; fits: boolean }[];
  readonly failedImages: string[];
}

/** Runs in the page: swap in the template, wait for fonts and images, fit captions. */
async function renderInPage(a: PageArgs): Promise<PageResult> {
  const root = document.getElementById("root")!;
  document.documentElement.lang = a.lang;
  document.documentElement.dir = a.dir;
  document.getElementById("tpl")!.textContent = a.css;
  root.innerHTML = a.html;
  if (a.text) {
    try {
      await document.fonts.load(a.font, a.text);
    } catch {
      // fall through to fonts.ready
    }
  }
  const failedImages: string[] = [];
  await Promise.all(Array.from(document.images, (img) => img.decode().catch(() => void failedImages.push(img.src))));
  await document.fonts.ready;

  const captions: PageResult["captions"] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(".cap"))) {
    const box = el.parentElement!;
    const maxLines = Number(el.dataset.lines);
    const baseSize = Number(el.dataset.size);
    const min = Number(el.dataset.min);
    let size = baseSize;
    const countLines = (): number => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const tops: number[] = [];
      for (const r of Array.from(range.getClientRects())) {
        if (r.width < 1 || r.height < 1) continue;
        if (!tops.some((t) => Math.abs(t - r.top) < size * 0.5)) tops.push(r.top);
      }
      return tops.length;
    };
    let lines = 0;
    let overflow = false;
    for (;;) {
      el.style.fontSize = `${size}px`;
      lines = countLines();
      overflow = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > box.clientHeight + 1;
      if ((lines <= maxLines && !overflow) || size <= min) break;
      size = Math.max(min, size * 0.965);
    }
    captions.push({ fontSize: Math.round(size * 10) / 10, baseSize, lines, fits: lines <= maxLines && !overflow });
  }
  return { captions, failedImages };
}

const cdpSessions = new WeakMap<Page, CDPSession>();

/**
 * Viewport PNG through CDP with optimizeForSpeed (faster zlib settings; about half the time of
 * page.screenshot). The result is re-encoded by sharp anyway.
 */
async function capturePng(page: Page): Promise<Buffer> {
  let cdp = cdpSessions.get(page);
  if (!cdp) {
    cdp = await page.context().newCDPSession(page);
    cdpSessions.set(page, cdp);
  }
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, captureBeyondViewport: false });
  return Buffer.from(data, "base64");
}

export async function createRenderer(options: RendererOptions = {}): Promise<Renderer> {
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const browser: Browser = await chromium.launch({
    headless: true,
    ...options.launch,
    args: [
      "--force-color-profile=srgb",
      "--font-render-hinting=none",
      "--disable-lcd-text",
      // Docker gives /dev/shm 64 MB by default; Chromium falls back to /tmp with this flag.
      ...(process.platform === "linux" ? ["--disable-dev-shm-usage"] : []),
      ...(options.launch?.args ?? []),
    ],
  });
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1206, height: 2622 }, deviceScaleFactor: 1 });
  const assets = new Map<string, Asset>();
  let nextAsset = 0;
  const shell = SHELL();

  await context.route(`${ORIGIN}/**`, async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: shell });
    if (path.startsWith("/fonts/")) {
      const font = fontFile(path.slice("/fonts/".length));
      if (font) return route.fulfill({ status: 200, contentType: "font/woff2", body: font });
    }
    if (path.startsWith("/assets/")) {
      const asset = assets.get(path.slice("/assets/".length));
      if (asset) return route.fulfill({ status: 200, contentType: asset.contentType, body: asset.body });
    }
    return route.fulfill({ status: 404, body: "not found" });
  });

  const idle: Page[] = [];
  let pages = 0;
  const waiting: ((p: Page) => void)[] = [];
  async function acquire(): Promise<Page> {
    const free = idle.pop();
    if (free) return free;
    if (pages < concurrency) {
      pages++;
      const page = await context.newPage();
      await page.goto(`${ORIGIN}/`);
      return page;
    }
    return new Promise((resolve) => waiting.push(resolve));
  }
  function release(page: Page): void {
    const next = waiting.shift();
    if (next) next(page);
    else idle.push(page);
  }

  function register(body: Buffer, contentType = sniff(body)): { id: string; url: string } {
    const id = `a${++nextAsset}`;
    assets.set(id, { body, contentType });
    return { id, url: `${ORIGIN}/assets/${id}` };
  }

  async function render(job: RenderJob): Promise<RenderResult> {
    const t0 = performance.now();
    const spec = SCREENSHOT_SETS[job.set];
    if (!spec) throw new Error(`Unknown screenshot set: ${job.set}`);
    const { width, height } = spec.portrait;
    const theme = job.theme ?? DEFAULT_THEME;
    const locale = job.locale ?? "en";
    const frame = job.frame ?? "device";
    const format = job.format ?? "png";
    const warnings: string[] = [];
    const used: string[] = [];

    const capture = await bytesOf(job.capture);
    const meta = await sharp(capture).metadata();
    const geometry = deviceGeometry(job.set);
    if (meta.width && meta.height) {
      const ratio = meta.width / meta.height / (geometry.screen.width / geometry.screen.height);
      if (Math.abs(ratio - 1) > 0.015) {
        warnings.push(
          `capture ${meta.width}x${meta.height} does not match the ${spec.label} screen (${geometry.screen.width}x${geometry.screen.height}); ` +
            `scaled to cover and cropped`,
        );
      }
    }
    const cap = register(capture);
    used.push(cap.id);

    let background: ResolvedBackground;
    const bg = theme.background;
    if (bg.kind === "image") {
      let url: string;
      if (typeof bg.src === "string" && /^(https?|data):/.test(bg.src)) url = bg.src;
      else {
        const a = register(await bytesOf(bg.src));
        used.push(a.id);
        url = a.url;
      }
      background = { kind: "image", url, ...(bg.tint ? { tint: bg.tint } : {}) };
    } else if (bg.kind === "gradient") {
      background = { kind: "gradient", from: bg.from, to: bg.to, angle: bg.angle ?? 180 };
    } else {
      background = bg;
    }

    let fontCss = "";
    if (theme.font?.src) {
      const a = register(await bytesOf(theme.font.src));
      used.push(a.id);
      fontCss = `@font-face{font-family:"${theme.font.family}";src:url("${a.url}");font-weight:100 900;font-display:block}`;
    }
    const typography = localeTypography(locale, theme.font?.family);
    const weight = theme.font?.weight ?? typography.weight;
    const tpl = buildTemplate(job.template ?? "caption-top", {
      width,
      height,
      geometry,
      frame,
      deviceColor: theme.deviceColor ?? "dark",
      captureUrl: cap.url,
      captionHtml: captionHtml(job.caption ?? "", typography.segmentWords ? typography.lang : undefined),
      typography: { ...typography, weight },
      background,
      captionColor: theme.captionColor,
      accent: theme.accent,
      index: job.index ?? 0,
      total: job.total ?? 1,
      captionPosition: job.captionPosition ?? "top",
      maxLines: job.maxLines ?? 2,
      shadow: job.shadow ?? 0.35,
    });

    const page = await acquire();
    let layoutMs: number;
    let shotMs: number;
    let raw: Buffer;
    let pageResult: PageResult;
    try {
      const vp = page.viewportSize();
      if (!vp || vp.width !== width || vp.height !== height) await page.setViewportSize({ width, height });
      pageResult = await page.evaluate(renderInPage, {
        html: tpl.html,
        css: fontCss + tpl.css,
        lang: typography.lang,
        dir: typography.dir,
        font: `${weight} 100px ${typography.fontStack}`,
        text: (job.caption ?? "").replace(/[*\n]/g, ""),
      });
      const t1 = performance.now();
      layoutMs = t1 - t0;
      raw = await capturePng(page);
      shotMs = performance.now() - t1;
    } finally {
      release(page);
      for (const id of used) assets.delete(id);
    }

    if (pageResult.failedImages.length) warnings.push(`images failed to load: ${pageResult.failedImages.join(", ")}`);
    const fit = pageResult.captions[0];
    if (fit && !fit.fits) warnings.push(`caption does not fit in ${job.maxLines ?? 2} lines even at ${fit.fontSize}px`);
    if (fit && fit.fontSize < fit.baseSize * 0.7) warnings.push(`caption shrunk to ${Math.round((fit.fontSize / fit.baseSize) * 100)}% of the base size`);

    const t2 = performance.now();
    const flat = sharp(raw).flatten({ background: "#000000" }).removeAlpha();
    const bytes =
      format === "jpeg"
        ? await flat.jpeg({ quality: job.jpegQuality ?? 92, chromaSubsampling: "4:4:4" }).toBuffer()
        : await flat.png({ compressionLevel: 6 }).toBuffer();
    const encodeMs = performance.now() - t2;
    return {
      bytes,
      width,
      height,
      format,
      ...(fit ? { caption: fit } : {}),
      warnings,
      ms: { total: performance.now() - t0, layout: layoutMs, screenshot: shotMs, encode: encodeMs },
    };
  }

  async function renderMany(jobs: readonly RenderJob[], onDone?: (index: number, result: RenderResult) => void): Promise<RenderResult[]> {
    const results: RenderResult[] = new Array(jobs.length);
    let next = 0;
    async function worker(): Promise<void> {
      while (next < jobs.length) {
        const i = next++;
        results[i] = await render(jobs[i]!);
        onDone?.(i, results[i]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
    return results;
  }

  return {
    render,
    renderMany,
    async close() {
      await context.close().catch(() => {});
      await browser.close();
    },
  };
}

/** Renders one screenshot with a short-lived browser; returns the image bytes (PNG unless `format` says otherwise). */
export async function renderScreenshot(job: RenderJob, renderer?: Renderer): Promise<Buffer> {
  if (renderer) return (await renderer.render(job)).bytes;
  const own = await createRenderer({ concurrency: 1 });
  try {
    return (await own.render(job)).bytes;
  } finally {
    await own.close();
  }
}

/** Renders a list of screenshots in one browser instance. */
export async function renderSet(
  jobs: readonly RenderJob[],
  options: RendererOptions & { readonly renderer?: Renderer; readonly onDone?: (index: number, result: RenderResult) => void } = {},
): Promise<RenderResult[]> {
  if (options.renderer) return options.renderer.renderMany(jobs, options.onDone);
  const own = await createRenderer(options);
  try {
    return await own.renderMany(jobs, options.onDone);
  } finally {
    await own.close();
  }
}
