/**
 * A DeviceDriver that needs no simulator: it draws a home-screen-like grid of tiles, highlights the
 * tile you tap, shows a ripple at every tap point and logs every call. For testing the agent ↔ web
 * connection (`shotwright-agent connect --fake`).
 */
import type {
  ElementSelector,
  LaunchOptions,
  Rect,
  ScreenInfo,
  SimDevice,
  SwipeGesture,
  TapTarget,
  UINode,
  UISnapshot,
} from "@shotwright/core";
import type { AgentDriver, AgentLogger, DriverFactory } from "./drivers.ts";
import { Canvas, hsl, type Rgb } from "./png.ts";

interface Tile {
  readonly id: string;
  readonly label: string;
  readonly frame: Rect;
  readonly hue: number;
}

interface Tap {
  readonly x: number;
  readonly y: number;
  readonly at: number;
}

const SPRINGBOARD = "com.apple.springboard";
const LABELS = [
  "Photos", "Camera", "Mail", "Notes", "Maps", "Music", "Clock", "Weather",
  "Wallet", "Health", "Books", "News", "Files", "Shortcuts", "Podcasts", "Stocks",
  "Calendar", "Reminders", "Contacts", "Settings",
];
const DOCK = ["Phone", "Safari", "Messages", "Store"];

/** Screen size in points and scale, guessed from the simulator's name. */
function screenFor(device: SimDevice | undefined): { width: number; height: number; scale: number } {
  const name = device?.name ?? "";
  if (/ipad/i.test(name)) return { width: 1032, height: 1376, scale: 2 };
  if (/duo/i.test(name)) return { width: 466, height: 678, scale: 3 };
  return { width: 440, height: 956, scale: 3 };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class FakeDriver implements AgentDriver {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  private readonly log: AgentLogger;
  private readonly tiles: Tile[] = [];
  private readonly highlighted = new Map<string, number>();
  private taps: Tap[] = [];
  private currentBundleId = SPRINGBOARD;
  private readonly started = Date.now();

  constructor(device: SimDevice | undefined, log: AgentLogger) {
    const screen = screenFor(device);
    this.width = screen.width;
    this.height = screen.height;
    this.scale = screen.scale;
    this.log = log;
    this.layout();
  }

  private layout(): void {
    const columns = this.width > 700 ? 6 : 4;
    const rows = Math.ceil(LABELS.length / columns);
    const size = Math.min(72, (this.width - 48) / columns - 22);
    const gapX = (this.width - columns * size) / (columns + 1);
    const top = 90;
    const gapY = Math.min(40, (this.height * 0.68 - top - rows * size) / rows);
    LABELS.forEach((label, i) => {
      const col = i % columns;
      const row = Math.floor(i / columns);
      this.tiles.push({
        id: `tile-${label.toLowerCase()}`,
        label,
        frame: { x: gapX + col * (size + gapX), y: top + row * (size + gapY), w: size, h: size },
        hue: (i * 360) / LABELS.length,
      });
    });
    const dockY = this.height - 34 - size - 22;
    DOCK.forEach((label, i) => {
      const gap = (this.width - DOCK.length * size) / (DOCK.length + 1);
      this.tiles.push({
        id: `dock-${label.toLowerCase()}`,
        label,
        frame: { x: gap + i * (size + gap), y: dockY, w: size, h: size },
        hue: 200 + i * 40,
      });
    });
  }

  private find(selector: ElementSelector): Tile {
    const tile = this.tiles.find(
      (t) => (selector.id !== undefined && t.id === selector.id) || (selector.label !== undefined && t.label === selector.label),
    );
    if (!tile) throw new Error(`No element matches ${JSON.stringify(selector)}`);
    return tile;
  }

  private hit(x: number, y: number): Tile | undefined {
    return this.tiles.find((t) => x >= t.frame.x && x <= t.frame.x + t.frame.w && y >= t.frame.y && y <= t.frame.y + t.frame.h);
  }

  async screen(): Promise<ScreenInfo> {
    return { width: this.width, height: this.height, currentBundleId: this.currentBundleId };
  }

  async launch(options: LaunchOptions): Promise<void> {
    this.log("info", `FakeDriver: launch ${options.bundleId}${options.args?.length ? ` ${options.args.join(" ")}` : ""}`);
    await sleep(300);
    this.currentBundleId = options.bundleId;
  }

  async terminate(bundleId?: string): Promise<void> {
    this.log("info", `FakeDriver: terminate ${bundleId ?? this.currentBundleId}`);
    this.currentBundleId = SPRINGBOARD;
  }

  async home(): Promise<void> {
    this.log("info", "FakeDriver: home");
    this.currentBundleId = SPRINGBOARD;
  }

  async source(): Promise<UISnapshot> {
    const children: UINode[] = this.tiles.map((t) => ({
      type: "Button",
      identifier: t.id,
      label: t.label,
      frame: t.frame,
      enabled: true,
      selected: this.highlighted.has(t.id),
    }));
    return {
      bundleId: this.currentBundleId,
      state: "runningForeground",
      count: children.length + 1,
      tree: { type: "Application", label: "Fake", frame: { x: 0, y: 0, w: this.width, h: this.height }, enabled: true, children },
    };
  }

  async screenshot(): Promise<Uint8Array> {
    return this.render();
  }

  async tap(target: TapTarget): Promise<void> {
    let x: number;
    let y: number;
    if ("x" in target) {
      ({ x, y } = target);
    } else {
      const { frame } = this.find(target);
      x = frame.x + frame.w / 2;
      y = frame.y + frame.h / 2;
    }
    if (x < 0 || y < 0 || x > this.width || y > this.height) {
      throw new Error(`Tap (${x}, ${y}) is outside the ${this.width} x ${this.height} pt screen`);
    }
    const now = Date.now();
    this.taps = [...this.taps.filter((t) => now - t.at < 1500), { x, y, at: now }];
    const tile = this.hit(x, y);
    if (tile) this.highlighted.set(tile.id, now + 1500);
    this.log("info", `FakeDriver: tap (${Math.round(x)}, ${Math.round(y)}) pt${tile ? ` on "${tile.label}"` : ""}`);
    await sleep(120);
  }

  async swipe(gesture: SwipeGesture): Promise<void> {
    this.log("info", `FakeDriver: swipe ${JSON.stringify(gesture)}`);
    await sleep(200);
  }

  async typeText(text: string, into?: ElementSelector): Promise<void> {
    this.log("info", `FakeDriver: type ${JSON.stringify(text)}${into ? ` into ${JSON.stringify(into)}` : ""}`);
  }

  async close(): Promise<void> {
    this.log("info", "FakeDriver: closed");
  }

  private render(): Buffer {
    const s = this.scale;
    const canvas = new Canvas(Math.round(this.width * s), Math.round(this.height * s));
    const now = Date.now();
    const t = (now - this.started) / 1000;

    // Background: a vertical gradient that slowly shifts hue, so a live view visibly moves.
    const hue = (t * 12) % 360;
    for (let y = 0; y < canvas.height; y++) {
      const f = y / canvas.height;
      canvas.fillRow(y, hsl((hue + f * 60) % 360, 0.55, 0.32 + f * 0.18));
    }

    const white: Rgb = [255, 255, 255];
    // Status bar: signal bars on the left, battery on the right.
    for (let i = 0; i < 4; i++) {
      canvas.fillRoundRect((34 + i * 6) * s, (26 - i * 2.5) * s, 4 * s, (6 + i * 2.5) * s, 1 * s, white);
    }
    canvas.fillRoundRect((this.width - 64) * s, 20 * s, 28 * s, 13 * s, 4 * s, white, 0.9);
    canvas.fillRoundRect((this.width - 35) * s, 24 * s, 2 * s, 5 * s, 1 * s, white, 0.9);
    // A second hand sweeping across under the status bar.
    canvas.fillRoundRect(24 * s, 52 * s, (this.width - 48) * s, 3 * s, 1.5 * s, white, 0.15);
    canvas.fillRoundRect(24 * s, 52 * s, ((this.width - 48) * ((t % 10) / 10)) * s, 3 * s, 1.5 * s, white, 0.7);

    // Dock background.
    const dock = this.tiles.find((tile) => tile.id.startsWith("dock-"));
    if (dock) {
      canvas.fillRoundRect(12 * s, (dock.frame.y - 14) * s, (this.width - 24) * s, (dock.frame.h + 28) * s, 32 * s, white, 0.18);
    }

    for (const tile of this.tiles) {
      const until = this.highlighted.get(tile.id);
      const lit = until !== undefined && until > now;
      if (until !== undefined && !lit) this.highlighted.delete(tile.id);
      const { x, y, w, h } = tile.frame;
      canvas.fillRoundRect(x * s, y * s, w * s, h * s, w * 0.23 * s, lit ? white : hsl(tile.hue, 0.7, 0.55));
      canvas.fillRoundRect((x + w * 0.3) * s, (y + h * 0.3) * s, w * 0.4 * s, h * 0.4 * s, w * 0.1 * s, lit ? hsl(tile.hue, 0.7, 0.5) : white, 0.85);
    }

    // Tap ripples: a ring that grows and fades over 1.5 s, and a dot at the tap point.
    for (const tap of this.taps) {
      const age = (now - tap.at) / 1500;
      if (age >= 1) continue;
      const radius = (12 + age * 40) * s;
      canvas.fillRing(tap.x * s, tap.y * s, radius - 3 * s, radius, white, 0.9 * (1 - age));
      canvas.fillRing(tap.x * s, tap.y * s, 0, 7 * s, [255, 59, 48], 1 - age);
    }

    // Home indicator.
    canvas.fillRoundRect((this.width / 2 - 70) * s, (this.height - 13) * s, 140 * s, 5 * s, 2.5 * s, white, 0.9);
    return canvas.toPng();
  }
}

export const createFakeDriver: DriverFactory = async ({ udid, device, log }) => {
  const driver = new FakeDriver(device, log);
  log("info", `FakeDriver ready for ${device?.name ?? udid} (${driver.width} x ${driver.height} pt @${driver.scale}x)`);
  return driver;
};
