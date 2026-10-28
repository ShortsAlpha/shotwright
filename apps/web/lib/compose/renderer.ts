/**
 * One headless Chromium for the whole server (every session's compose jobs and previews share it),
 * started on first use and closed after a few idle minutes, since it holds ~150-250 MB.
 * Lives on globalThis like the hub, so code bundled by Next sees the same instance.
 */
import { createRenderer, type RenderJob, type RenderResult, type Renderer } from "@shotwright/render";

const IDLE_MS = Number(process.env.SHOTWRIGHT_RENDERER_IDLE_MS ?? 5 * 60_000);

interface Shared {
  renderer: Promise<Renderer> | null;
  busy: number;
  timer: NodeJS.Timeout | undefined;
}

const KEY = Symbol.for("shotwright.renderer");

function shared(): Shared {
  const store = globalThis as typeof globalThis & { [KEY]?: Shared };
  return (store[KEY] ??= { renderer: null, busy: 0, timer: undefined });
}

function get(): Promise<Renderer> {
  const s = shared();
  clearTimeout(s.timer);
  if (!s.renderer) {
    const started = createRenderer({ concurrency: 2 });
    s.renderer = started;
    started.catch(() => {
      if (s.renderer === started) s.renderer = null;
    });
  }
  return s.renderer;
}

function scheduleClose(): void {
  const s = shared();
  clearTimeout(s.timer);
  if (s.busy > 0 || !s.renderer) return;
  s.timer = setTimeout(() => void closeRenderer(), IDLE_MS);
  s.timer.unref();
}

/** Renders one screenshot on the shared browser; restarts the browser once if it died. */
export async function renderShared(job: RenderJob): Promise<RenderResult> {
  const s = shared();
  s.busy++;
  try {
    const renderer = await get();
    try {
      return await renderer.render(job);
    } catch (error) {
      if (!/closed|crash|disconnected|Target page/i.test(error instanceof Error ? error.message : String(error))) throw error;
      // The browser went away (crash, OOM kill): start a new one and try once more.
      if (s.renderer) await (await s.renderer.catch(() => null))?.close().catch(() => undefined);
      s.renderer = null;
      return await (await get()).render(job);
    }
  } finally {
    s.busy--;
    scheduleClose();
  }
}

export async function closeRenderer(): Promise<void> {
  const s = shared();
  clearTimeout(s.timer);
  const current = s.renderer;
  s.renderer = null;
  const renderer = await current?.catch(() => null);
  await renderer?.close().catch(() => undefined);
}
