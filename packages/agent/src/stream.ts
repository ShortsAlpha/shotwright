/**
 * Live view: polls the driver's screenshot at a fixed rate, downscales it to JPEG with ffmpeg and
 * sends it as a `frame`. One capture runs at a time, and a frame is skipped while the socket still
 * has unsent data, so frames never pile up.
 */
import type { DeviceDriver, Frame } from "@shotwright/core";
import type { AgentLogger } from "./drivers.ts";
import { pipeThrough } from "./exec.ts";
import { pngSize } from "./png.ts";

export interface FrameSink {
  /** False while earlier frames are still being sent. */
  ready(): boolean;
  send(frame: Frame): void;
}

export const DEFAULT_FPS = 4;
export const DEFAULT_MAX_WIDTH = 540;

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Downscales a PNG to at most `maxWidth` pixels wide and encodes it as JPEG. */
export async function toJpeg(png: Uint8Array, maxWidth: number): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const source = pngSize(png);
  const width = even(Math.min(maxWidth, source.width));
  const height = even((source.height * width) / source.width);
  const jpeg = await pipeThrough(
    "ffmpeg",
    [
      "-v", "error", "-f", "png_pipe", "-i", "pipe:0",
      "-vf", `scale=${width}:${height}:flags=bilinear`,
      "-frames:v", "1", "-q:v", "5", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1",
    ],
    png,
  );
  return { jpeg, width, height };
}

export class Streamer {
  private generation = 0;
  private readonly getDriver: () => DeviceDriver | null;
  private readonly sink: FrameSink;
  private readonly log: AgentLogger;

  constructor(getDriver: () => DeviceDriver | null, sink: FrameSink, log: AgentLogger) {
    this.getDriver = getDriver;
    this.sink = sink;
    this.log = log;
  }

  get running(): boolean {
    return this.generation % 2 === 1;
  }

  start(fps: number, maxWidth: number): void {
    this.stop();
    this.generation++;
    void this.loop(this.generation, 1000 / fps, maxWidth);
  }

  stop(): void {
    if (this.running) this.generation++;
  }

  private async loop(generation: number, intervalMs: number, maxWidth: number): Promise<void> {
    let seq = 0;
    let failures = 0;
    while (generation === this.generation) {
      const started = performance.now();
      try {
        const driver = this.getDriver();
        if (!driver) throw new Error("No device driver; run runner.ensure first");
        if (this.sink.ready()) {
          const png = await driver.screenshot();
          if (generation !== this.generation) break;
          const { jpeg, width, height } = await toJpeg(png, maxWidth);
          if (generation !== this.generation) break;
          this.sink.send({ type: "frame", seq: seq++, mime: "image/jpeg", data: jpeg.toString("base64"), width, height });
        }
        if (failures > 0) this.log("info", "Live view recovered");
        failures = 0;
      } catch (error) {
        failures++;
        if (failures === 1 || failures % 30 === 0) {
          this.log("warn", `Live view: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const elapsed = performance.now() - started;
      await sleep(failures > 0 ? Math.max(1000, intervalMs) : Math.max(0, intervalMs - elapsed));
    }
  }
}
