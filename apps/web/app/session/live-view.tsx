"use client";

import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import type { Frame } from "@shotwright/core";
import type { SessionState } from "../../lib/ui-protocol.ts";
import { HomeIcon, PlayIcon, Spinner, StopIcon } from "../_components/icons.tsx";
import type { SessionApi } from "./use-session.ts";

/** Pixels the pointer may move and still count as a tap rather than a swipe. */
const TAP_SLOP = 8;
/** JPEG width requested from the agent: sharp on a 2x display at the size shown here. */
const STREAM_MAX_WIDTH = 720;

interface Ripple {
  readonly id: number;
  /** Position as a fraction of the screen. */
  readonly fx: number;
  readonly fy: number;
}

interface PointerStart {
  readonly clientX: number;
  readonly clientY: number;
  readonly fx: number;
  readonly fy: number;
  readonly time: number;
}

const iconButton =
  "inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800";

export function LiveView({
  session,
  state,
  onError,
}: {
  session: Pick<SessionApi, "call" | "subscribeFrames">;
  state: SessionState;
  onError: (error: unknown) => void;
}) {
  const { call, subscribeFrames } = session;
  const image = useRef<HTMLImageElement>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [fps, setFps] = useState(0);
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [lastInput, setLastInput] = useState<string | null>(null);
  const pointerStart = useRef<PointerStart | null>(null);
  const frameTimes = useRef<number[]>([]);
  const rippleId = useRef(0);

  const device = state.devices?.find((d) => d.udid === state.activeUdid);
  const screen = state.screen;
  const interactive = state.streaming && state.agent.connected && screen !== null && frameSize !== null;

  // Draw frames straight into the <img>, outside React rendering.
  useEffect(
    () =>
      subscribeFrames((frame: Frame) => {
        const img = image.current;
        if (!img) return;
        img.src = `data:${frame.mime};base64,${frame.data}`;
        const now = performance.now();
        frameTimes.current = [...frameTimes.current.filter((t) => now - t < 2000), now];
        setFrameSize((size) => (size?.width === frame.width && size.height === frame.height ? size : { width: frame.width, height: frame.height }));
      }),
    [subscribeFrames],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      const now = performance.now();
      frameTimes.current = frameTimes.current.filter((t) => now - t < 2000);
      setFps(frameTimes.current.length / 2);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // A different simulator (or none): forget the old picture.
  useEffect(() => {
    setFrameSize(null);
    if (image.current) image.current.removeAttribute("src");
  }, [state.activeUdid]);

  const run = (promise: Promise<unknown>) => promise.catch(onError);

  const startStream = () => run(call("stream.start", { fps: 4, maxWidth: STREAM_MAX_WIDTH }));
  const stopStream = () => run(call("stream.stop", {}));

  /** Pointer position as a fraction (0..1) of the displayed screen. */
  const fraction = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return { fx: clamp((event.clientX - rect.left) / rect.width), fy: clamp((event.clientY - rect.top) / rect.height) };
  };

  /**
   * Image coordinates to points: the frame is the screen scaled to `frameSize` pixels, so
   * a pixel (px, py) in the frame is (px * screen.width / frame.width, py * screen.height / frame.height) pt.
   */
  const toPoint = (fx: number, fy: number) => {
    if (!screen || !frameSize) return { x: 0, y: 0 };
    const px = fx * frameSize.width;
    const py = fy * frameSize.height;
    return { x: Math.round((px * screen.width) / frameSize.width), y: Math.round((py * screen.height) / frameSize.height) };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactive || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerStart.current = { clientX: event.clientX, clientY: event.clientY, ...fraction(event), time: performance.now() };
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!start || !interactive) return;
    const moved = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY);
    const from = toPoint(start.fx, start.fy);
    if (moved < TAP_SLOP) {
      const id = ++rippleId.current;
      setRipples((list) => [...list, { id, fx: start.fx, fy: start.fy }]);
      setTimeout(() => setRipples((list) => list.filter((r) => r.id !== id)), 700);
      setLastInput(`Tap at ${from.x}, ${from.y} pt`);
      void run(call("driver.tap", from));
    } else {
      const end = fraction(event);
      const to = toPoint(end.fx, end.fy);
      const durationMs = Math.round(Math.min(1500, Math.max(150, performance.now() - start.time)));
      setLastInput(`Swipe ${from.x}, ${from.y} → ${to.x}, ${to.y} pt`);
      void run(call("driver.swipe", { from, to, durationMs }));
    }
  };

  const ratio = screen ? screen.width / screen.height : frameSize ? frameSize.width / frameSize.height : 440 / 956;
  const tablet = ratio > 0.65;

  let placeholder: ReactNode = null;
  if (!state.agent.connected) placeholder = <p>The Mac agent is offline.</p>;
  else if (!state.activeUdid) placeholder = <p>Pick a simulator and press <strong>Live view</strong>.</p>;
  else if (!state.streaming)
    placeholder = (
      <button type="button" onClick={startStream} className="inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20">
        <PlayIcon className="size-4" /> Start live view
      </button>
    );
  else if (!frameSize)
    placeholder = (
      <p className="inline-flex items-center gap-2">
        <Spinner /> Waiting for the first frame…
      </p>
    );

  return (
    <section className="flex min-h-0 flex-col rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Live view</h2>
          <p className="truncate text-xs text-neutral-500">
            {device ? `${device.name} · ${device.runtime}` : "No simulator selected"}
            {screen && ` · ${screen.width} × ${screen.height} pt`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {state.streaming && (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-600 tabular-nums dark:bg-red-950/50 dark:text-red-400">
              <span className="size-1.5 animate-pulse rounded-full bg-red-500" /> LIVE · {fps.toFixed(1)} fps
            </span>
          )}
          <button type="button" className={iconButton} onClick={() => run(call("driver.home", {}))} disabled={!interactive} title="Home">
            <HomeIcon className="size-3.5" /> Home
          </button>
          {state.streaming ? (
            <button type="button" className={iconButton} onClick={stopStream} disabled={!state.agent.connected}>
              <StopIcon className="size-3.5" /> Stop
            </button>
          ) : (
            <button type="button" className={iconButton} onClick={startStream} disabled={!state.agent.connected || !state.activeUdid}>
              <PlayIcon className="size-3.5" /> Start
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-1 items-center justify-center bg-neutral-50 p-6 dark:bg-neutral-950/40">
        <div
          className={`bg-neutral-900 p-2.5 shadow-2xl shadow-neutral-900/20 ring-1 ring-neutral-800 dark:ring-neutral-700 ${tablet ? "rounded-[1.75rem]" : "rounded-[2.75rem]"}`}
          style={{ width: `min(100%, calc(min(70vh, 820px) * ${ratio}))` }}
        >
          <div
            className={`relative w-full touch-none select-none overflow-hidden bg-neutral-800 ${tablet ? "rounded-[1.2rem]" : "rounded-[2.2rem]"} ${interactive ? "cursor-pointer" : ""}`}
            style={{ aspectRatio: ratio }}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={() => (pointerStart.current = null)}
          >
            {/* A plain <img>: frames are data URLs replaced several times a second. */}
            <img
              ref={image}
              alt={device ? `Live screen of ${device.name}` : ""}
              draggable={false}
              className={`absolute inset-0 size-full transition-opacity ${frameSize ? "" : "opacity-0"} ${state.streaming && state.agent.connected ? "" : "opacity-40 grayscale"}`}
            />
            {placeholder && (
              <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-neutral-300">{placeholder}</div>
            )}
            {ripples.map((r) => (
              <span
                key={r.id}
                className="tap-ripple pointer-events-none absolute size-10 rounded-full border-2 border-white bg-white/30"
                style={{ left: `${r.fx * 100}%`, top: `${r.fy * 100}%` }}
              />
            ))}
          </div>
        </div>
      </div>

      <footer className="border-t border-neutral-100 px-4 py-2.5 text-xs text-neutral-500 dark:border-neutral-800">
        {interactive ? (lastInput ?? "Click to tap, drag to swipe.") : "Click the screen to tap once the live view is running."}
      </footer>
    </section>
  );
}
