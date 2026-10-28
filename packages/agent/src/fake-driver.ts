/**
 * A DeviceDriver that needs no simulator, for testing the agent ↔ web connection and the explore
 * flow (`shotwright-agent connect --fake`).
 *
 * - Home screen: a grid of tiles; the tile you tap lights up, and every tap leaves a ripple.
 * - Any launched app: a small subscription tracker with Home (list), detail, Calendar and Insights
 *   screens and a tab bar. Its accessibility tree looks like the runner's (lowercase XCUI types,
 *   identifiers, a localized navigation bar), and `-AppleLanguages (de|ja)` switches its labels and
 *   accent colour, so exploration, recorded flows and per-locale replays can run against it.
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

// --- The fake app -------------------------------------------------------------

type AppTab = "home" | "calendar" | "insights";

interface AppState {
  tab: AppTab;
  /** Index into SUBSCRIPTIONS of the open detail screen (Home tab only). */
  detail: number | null;
  language: string;
}

const SUBSCRIPTIONS = [
  { id: "netflix", name: "Netflix", usd: 15.49, hue: 0, day: 3 },
  { id: "spotify", name: "Spotify", usd: 11.99, hue: 140, day: 9 },
  { id: "icloud", name: "iCloud+", usd: 2.99, hue: 205, day: 12 },
  { id: "notion", name: "Notion", usd: 10, hue: 35, day: 17 },
  { id: "disney", name: "Disney+", usd: 13.99, hue: 235, day: 22 },
  { id: "gym", name: "Gym", usd: 39, hue: 290, day: 28 },
] as const;

const STRINGS: Record<string, Record<string, string>> = {
  en: { home: "Home", calendar: "Calendar", insights: "Insights", back: "Back", monthly: "Monthly", upcoming: "Upcoming", total: "Monthly total", month: "October 2026", previous: "Previous Month", spending: "Spending by service", renews: "Renews" },
  de: { home: "Start", calendar: "Kalender", insights: "Statistik", back: "Zurück", monthly: "Monatlich", upcoming: "Demnächst", total: "Monatlich gesamt", month: "Oktober 2026", previous: "Vorheriger Monat", spending: "Ausgaben nach Dienst", renews: "Verlängert" },
  ja: { home: "ホーム", calendar: "カレンダー", insights: "分析", back: "戻る", monthly: "毎月", upcoming: "今後", total: "月額合計", month: "2026年10月", previous: "前の月", spending: "サービス別の支出", renews: "更新" },
};

/** Accent hue per language, so replays in different locales look different. */
const ACCENT: Record<string, number> = { en: 235, de: 28, ja: 340 };

const TAB_IDS: Record<AppTab, string> = { home: "house", calendar: "calendar", insights: "chart.pie" };

function price(usd: number, language: string): string {
  if (language === "de") return `${(usd * 0.92).toFixed(2).replace(".", ",")} €`;
  if (language === "ja") return `¥${Math.round(usd * 150).toLocaleString("en-US")}`;
  return `$${usd.toFixed(2)}`;
}

/** "(de)" from `-AppleLanguages (de)` in the launch arguments. */
function languageOf(args: readonly string[] | undefined): string {
  const i = args?.indexOf("-AppleLanguages") ?? -1;
  const value = i >= 0 ? args?.[i + 1] : undefined;
  const language = value?.replace(/[()"\s]/g, "").split(",")[0];
  return language && STRINGS[language] ? language : "en";
}

const node = (type: string, frame: Rect, extra: Partial<Omit<UINode, "type" | "frame">> = {}): UINode => ({
  type,
  frame,
  enabled: true,
  ...extra,
});

/** Screen size in points and scale, guessed from the simulator's name. */
function screenFor(device: SimDevice | undefined): { width: number; height: number; scale: number } {
  const name = device?.name ?? "";
  if (/ipad/i.test(name)) return { width: 1032, height: 1376, scale: 2 };
  if (/duo/i.test(name)) return { width: 466, height: 678, scale: 3 };
  if (/6\.3/.test(name)) return { width: 402, height: 874, scale: 3 };
  return { width: 440, height: 956, scale: 3 };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const contains = (frame: Rect, x: number, y: number) => x >= frame.x && x <= frame.x + frame.w && y >= frame.y && y <= frame.y + frame.h;

export class FakeDriver implements AgentDriver {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  private readonly log: AgentLogger;
  private readonly tiles: Tile[] = [];
  private readonly highlighted = new Map<string, number>();
  private taps: Tap[] = [];
  private currentBundleId = SPRINGBOARD;
  private app: AppState = { tab: "home", detail: null, language: "en" };
  private statusBarOverride = false;
  private readonly started = Date.now();

  constructor(device: SimDevice | undefined, log: AgentLogger) {
    const screen = screenFor(device);
    this.width = screen.width;
    this.height = screen.height;
    this.scale = screen.scale;
    this.log = log;
    this.layout();
  }

  private get inApp(): boolean {
    return this.currentBundleId !== SPRINGBOARD;
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

  // --- Accessibility trees --------------------------------------------------------

  private springboardTree(): UINode {
    const children: UINode[] = this.tiles.map((t) =>
      node("icon", t.frame, { identifier: t.id, label: t.label, selected: this.highlighted.has(t.id) }),
    );
    return node("application", { x: 0, y: 0, w: this.width, h: this.height }, { label: "SpringBoard", children });
  }

  /** Geometry shared by the tree and the renderer. */
  private appLayout() {
    const W = this.width;
    const H = this.height;
    const tabBar: Rect = { x: 0, y: H - 83, w: W, h: 83 };
    const navBar: Rect = { x: 0, y: 54, w: W, h: 52 };
    const content: Rect = { x: 0, y: 106, w: W, h: tabBar.y - 106 };
    const summary: Rect = { x: 16, y: 116, w: W - 32, h: 110 };
    const rows = SUBSCRIPTIONS.map((_, i): Rect => ({ x: 16, y: 262 + i * 70, w: W - 32, h: 60 }));
    const tabs = (["home", "calendar", "insights"] as const).map((tab, i) => ({ tab, frame: { x: (W / 3) * i, y: tabBar.y, w: W / 3, h: 49 } }));
    const back: Rect = { x: 8, y: 60, w: 84, h: 40 };
    const card: Rect = { x: 16, y: 120, w: W - 32, h: 190 };
    const cell = (W - 32) / 7;
    const day = (n: number): Rect => ({ x: 16 + ((n + 2) % 7) * cell, y: 190 + Math.floor((n + 2) / 7) * cell, w: cell, h: cell });
    const previous: Rect = { x: W - 64, y: 126, w: 44, h: 44 };
    const chart: Rect = { x: W / 2 - 110, y: 150, w: 220, h: 220 };
    return { W, H, tabBar, navBar, content, summary, rows, tabs, back, card, day, cell, previous, chart };
  }

  private appTree(): UINode {
    const L = this.appLayout();
    const s = STRINGS[this.app.language] ?? STRINGS.en!;
    const t = (key: string) => s[key] ?? key;
    const children: UINode[] = [];
    const detail = this.app.tab === "home" && this.app.detail !== null ? SUBSCRIPTIONS[this.app.detail] : undefined;

    if (detail) {
      children.push(
        node("navigationBar", L.navBar, {
          identifier: detail.name,
          label: detail.name,
          children: [node("button", L.back, { identifier: "BackButton", label: t("back") })],
        }),
        node("other", L.content, {
          identifier: "subscription.detail",
          children: [
            node("staticText", { x: 32, y: 140, w: 200, h: 30 }, { label: detail.name }),
            node("staticText", { x: 32, y: 180, w: 160, h: 40 }, { label: price(detail.usd, this.app.language) }),
            node("staticText", { x: 32, y: 330, w: L.W - 64, h: 24 }, { label: `${t("renews")} ${detail.day}.10.2026` }),
            node("staticText", { x: 32, y: 370, w: L.W - 64, h: 24 }, { label: t("monthly") }),
          ],
        }),
      );
    } else if (this.app.tab === "home") {
      children.push(
        node("navigationBar", L.navBar, { identifier: t("home"), label: t("home") }),
        node("other", L.content, {
          identifier: "home.ready",
          children: [
            node("other", L.summary, {
              identifier: "home.summary",
              children: [
                node("staticText", { x: 32, y: 130, w: 200, h: 20 }, { label: t("total") }),
                node("staticText", { x: 32, y: 160, w: 200, h: 40 }, { label: price(SUBSCRIPTIONS.reduce((sum, sub) => sum + sub.usd, 0), this.app.language) }),
              ],
            }),
            node("staticText", { x: 20, y: 236, w: 200, h: 20 }, { label: t("upcoming") }),
            ...SUBSCRIPTIONS.map((sub, i) =>
              node("button", L.rows[i]!, {
                identifier: `row.${sub.id}`,
                label: `${sub.name}, ${price(sub.usd, this.app.language)}, ${t("monthly")}`,
                children: [node("staticText", { x: 76, y: L.rows[i]!.y + 10, w: 160, h: 20 }, { label: sub.name })],
              }),
            ),
          ],
        }),
      );
    } else if (this.app.tab === "calendar") {
      children.push(
        node("navigationBar", L.navBar, { identifier: t("month"), label: t("month") }),
        node("other", L.content, {
          identifier: "calendar.grid",
          children: [
            node("button", L.previous, { identifier: "calendar.previousMonth", label: t("previous") }),
            ...SUBSCRIPTIONS.map((sub) => node("button", L.day(sub.day), { identifier: `day.${sub.day}`, label: `${sub.day}, ${sub.name}` })),
          ],
        }),
      );
    } else {
      children.push(
        node("navigationBar", L.navBar, { identifier: t("insights"), label: t("insights") }),
        node("other", L.content, {
          identifier: "insights",
          children: [
            node("image", L.chart, { identifier: "insights.chart", label: t("spending") }),
            ...SUBSCRIPTIONS.slice(0, 3).map((sub, i) =>
              node("staticText", { x: 32, y: 420 + i * 36, w: L.W - 64, h: 24 }, { label: `${sub.name} ${price(sub.usd, this.app.language)}` }),
            ),
          ],
        }),
      );
    }

    children.push(
      node("tabBar", L.tabBar, {
        identifier: "Tab Bar",
        children: L.tabs.map(({ tab, frame }) =>
          node("button", frame, { identifier: TAB_IDS[tab], label: t(tab), selected: this.app.tab === tab }),
        ),
      }),
    );
    return node("application", { x: 0, y: 0, w: L.W, h: L.H }, { label: "FakeApp", children });
  }

  private tree(): UINode {
    return this.inApp ? this.appTree() : this.springboardTree();
  }

  /** Interactive nodes, smallest first, for hit testing and selector taps. */
  private targets(): UINode[] {
    const out: UINode[] = [];
    const walk = (n: UINode) => {
      if (n.type === "button" || n.type === "icon") out.push(n);
      for (const child of n.children ?? []) walk(child);
    };
    walk(this.tree());
    return out.sort((a, b) => a.frame.w * a.frame.h - b.frame.w * b.frame.h);
  }

  /** Runs the app's reaction to a tap on `target`. */
  private press(target: UINode): void {
    if (!this.inApp) {
      if (target.identifier) this.highlighted.set(target.identifier, Date.now() + 1500);
      return;
    }
    const id = target.identifier ?? "";
    const tab = (Object.keys(TAB_IDS) as AppTab[]).find((key) => TAB_IDS[key] === id);
    if (tab) {
      // Like UIKit: tapping the selected tab pops to its root, another tab keeps its stack.
      if (tab === this.app.tab) this.app.detail = null;
      this.app.tab = tab;
    } else if (id === "BackButton") {
      this.app.detail = null;
    } else if (id.startsWith("row.")) {
      const index = SUBSCRIPTIONS.findIndex((sub) => `row.${sub.id}` === id);
      if (index >= 0) this.app.detail = index;
    }
  }

  // --- DeviceDriver ---------------------------------------------------------------

  async screen(): Promise<ScreenInfo> {
    return { width: this.width, height: this.height, currentBundleId: this.currentBundleId };
  }

  async launch(options: LaunchOptions): Promise<void> {
    this.log("info", `FakeDriver: launch ${options.bundleId}${options.args?.length ? ` ${options.args.join(" ")}` : ""}`);
    await sleep(600);
    this.currentBundleId = options.bundleId;
    this.app = { tab: "home", detail: null, language: languageOf(options.args) };
  }

  async terminate(bundleId?: string): Promise<void> {
    this.log("info", `FakeDriver: terminate ${bundleId ?? this.currentBundleId}`);
    this.currentBundleId = SPRINGBOARD;
  }

  async home(): Promise<void> {
    this.log("info", "FakeDriver: home");
    this.currentBundleId = SPRINGBOARD;
  }

  async source(bundleId?: string): Promise<UISnapshot> {
    await sleep(40);
    const tree = this.tree();
    let count = 0;
    const walk = (n: UINode) => {
      count++;
      for (const child of n.children ?? []) walk(child);
    };
    walk(tree);
    const background = bundleId !== undefined && bundleId !== this.currentBundleId;
    return { bundleId: bundleId ?? this.currentBundleId, state: background ? "background" : "foreground", count, tree };
  }

  async waitForStable(options: { bundleId?: string; timeoutMs?: number }): Promise<UISnapshot> {
    return this.source(options.bundleId);
  }

  async screenshot(): Promise<Uint8Array> {
    await sleep(60);
    return this.render();
  }

  async tap(target: TapTarget): Promise<void> {
    let x: number;
    let y: number;
    let hit: UINode | undefined;
    if ("x" in target) {
      ({ x, y } = target);
      if (x < 0 || y < 0 || x > this.width || y > this.height) {
        throw new Error(`Tap (${x}, ${y}) is outside the ${this.width} x ${this.height} pt screen`);
      }
      hit = this.targets().find((n) => contains(n.frame, x, y));
    } else {
      hit = this.targets().find(
        (n) => (target.id === undefined || n.identifier === target.id) && (target.label === undefined || n.label === target.label),
      );
      if (!hit) throw new Error(`No element matches ${JSON.stringify(target)}`);
      x = hit.frame.x + hit.frame.w / 2;
      y = hit.frame.y + hit.frame.h / 2;
    }
    const now = Date.now();
    this.taps = [...this.taps.filter((t) => now - t.at < 1500), { x, y, at: now }];
    if (hit) this.press(hit);
    this.log("info", `FakeDriver: tap (${Math.round(x)}, ${Math.round(y)}) pt${hit?.label ? ` on "${hit.label}"` : ""}`);
    await sleep(250);
  }

  async swipe(gesture: SwipeGesture): Promise<void> {
    this.log("info", `FakeDriver: swipe ${JSON.stringify(gesture)}`);
    await sleep(200);
  }

  async typeText(text: string, into?: ElementSelector): Promise<void> {
    this.log("info", `FakeDriver: type ${JSON.stringify(text)}${into ? ` into ${JSON.stringify(into)}` : ""}`);
  }

  async statusBar(override: boolean): Promise<void> {
    this.statusBarOverride = override;
    this.log("info", `FakeDriver: status bar ${override ? "set to 9:41" : "cleared"}`);
  }

  async close(): Promise<void> {
    this.log("info", "FakeDriver: closed");
  }

  // --- Rendering ------------------------------------------------------------------

  private render(): Buffer {
    const canvas = new Canvas(Math.round(this.width * this.scale), Math.round(this.height * this.scale));
    // Ripples only on the home screen: the app's screenshots end up as marked screens.
    if (this.inApp) this.renderApp(canvas);
    else {
      this.renderSpringboard(canvas);
      this.renderTaps(canvas);
    }
    return canvas.toPng();
  }

  private renderStatusBar(canvas: Canvas, color: Rgb): void {
    const s = this.scale;
    for (let i = 0; i < 4; i++) {
      canvas.fillRoundRect((34 + i * 6) * s, (26 - i * 2.5) * s, 4 * s, (6 + i * 2.5) * s, 1 * s, color);
    }
    canvas.fillRoundRect((this.width - 64) * s, 20 * s, 28 * s, 13 * s, 4 * s, color, 0.9);
    canvas.fillRoundRect((this.width - 35) * s, 24 * s, 2 * s, 5 * s, 1 * s, color, 0.9);
  }

  private renderSpringboard(canvas: Canvas): void {
    const s = this.scale;
    const now = Date.now();
    const t = (now - this.started) / 1000;

    // Background: a vertical gradient that slowly shifts hue, so a live view visibly moves.
    const hue = (t * 12) % 360;
    for (let y = 0; y < canvas.height; y++) {
      const f = y / canvas.height;
      canvas.fillRow(y, hsl((hue + f * 60) % 360, 0.55, 0.32 + f * 0.18));
    }

    const white: Rgb = [255, 255, 255];
    this.renderStatusBar(canvas, white);
    // A second hand sweeping across under the status bar.
    canvas.fillRoundRect(24 * s, 52 * s, (this.width - 48) * s, 3 * s, 1.5 * s, white, 0.15);
    canvas.fillRoundRect(24 * s, 52 * s, ((this.width - 48) * ((t % 10) / 10)) * s, 3 * s, 1.5 * s, white, 0.7);

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
    canvas.fillRoundRect((this.width / 2 - 70) * s, (this.height - 13) * s, 140 * s, 5 * s, 2.5 * s, white, 0.9);
  }

  private renderApp(canvas: Canvas): void {
    const s = this.scale;
    const L = this.appLayout();
    const accent = ACCENT[this.app.language] ?? 170;
    const ink: Rgb = [28, 28, 30];
    const muted: Rgb = [174, 174, 178];
    const white: Rgb = [255, 255, 255];
    const box = (r: Rect, radius: number, color: Rgb, alpha = 1) => canvas.fillRoundRect(r.x * s, r.y * s, r.w * s, r.h * s, radius * s, color, alpha);
    /** A grey bar standing in for a line of text. */
    const text = (x: number, y: number, w: number, h = 10, color: Rgb = muted) => box({ x, y, w, h }, h / 2, color);

    for (let y = 0; y < canvas.height; y++) canvas.fillRow(y, [242, 242, 247]);
    this.renderStatusBar(canvas, ink);
    if (this.statusBarOverride) text(L.W / 2 - 18, 22, 36, 11, ink); // "9:41"

    const detail = this.app.tab === "home" && this.app.detail !== null ? SUBSCRIPTIONS[this.app.detail] : undefined;
    if (detail) {
      box(L.back, 12, hsl(accent, 0.7, 0.55), 0.15);
      text(L.back.x + 14, L.back.y + 15, 52, 10, hsl(accent, 0.7, 0.5));
      box(L.card, 22, hsl(detail.hue, 0.65, 0.55));
      canvas.fillRing((L.card.x + 52) * s, (L.card.y + 52) * s, 0, 30 * s, white, 0.9);
      text(L.card.x + 100, L.card.y + 34, 140, 16, white);
      text(L.card.x + 100, L.card.y + 62, 90, 12, white);
      text(L.card.x + 24, L.card.y + 120, 150, 26, white);
      for (let i = 0; i < 4; i++) {
        box({ x: 16, y: 330 + i * 58, w: L.W - 32, h: 48 }, 14, white);
        text(32, 349 + i * 58, 110);
        text(L.W - 112, 349 + i * 58, 80, 10, ink);
      }
    } else if (this.app.tab === "home") {
      text(16, 68, 110, 22, ink);
      box(L.summary, 22, hsl(accent, 0.65, 0.55));
      text(L.summary.x + 18, L.summary.y + 18, 120, 10, white);
      text(L.summary.x + 18, L.summary.y + 44, 170, 30, white);
      for (let i = 0; i < 12; i++) {
        const h = 14 + ((i * 37) % 40);
        box({ x: L.summary.x + L.summary.w - 150 + i * 11, y: L.summary.y + L.summary.h - 18 - h, w: 7, h }, 3, white, 0.75);
      }
      text(20, 240, 90, 12, ink);
      SUBSCRIPTIONS.forEach((sub, i) => {
        const r = L.rows[i]!;
        box(r, 16, white);
        canvas.fillRing((r.x + 32) * s, (r.y + r.h / 2) * s, 0, 18 * s, hsl(sub.hue, 0.7, 0.55));
        text(r.x + 62, r.y + 16, 100 + ((i * 23) % 50), 11, ink);
        text(r.x + 62, r.y + 36, 70);
        text(r.x + r.w - 86, r.y + 24, 66, 12, ink);
      });
    } else if (this.app.tab === "calendar") {
      text(16, 68, 150, 22, ink);
      canvas.fillRing((L.previous.x + 22) * s, (L.previous.y + 22) * s, 0, 18 * s, hsl(accent, 0.7, 0.55), 0.18);
      for (let n = 1; n <= 31; n++) {
        const d = L.day(n);
        const sub = SUBSCRIPTIONS.find((item) => item.day === n);
        box({ x: d.x + 3, y: d.y + 3, w: d.w - 6, h: d.h - 6 }, 10, sub ? hsl(sub.hue, 0.65, 0.6) : white, sub ? 0.9 : 1);
        text(d.x + d.w / 2 - 7, d.y + 12, 14, 8, sub ? white : muted);
        if (n === 28) canvas.fillRing((d.x + d.w / 2) * s, (d.y + d.h - 12) * s, 0, 3 * s, hsl(accent, 0.8, 0.5));
      }
      box({ x: 16, y: L.day(31).y + L.cell + 16, w: L.W - 32, h: 70 }, 16, white);
      text(32, L.day(31).y + L.cell + 36, 160, 11, ink);
      text(32, L.day(31).y + L.cell + 56, 100);
    } else {
      text(16, 68, 120, 22, ink);
      const cx = (L.chart.x + L.chart.w / 2) * s;
      const cy = (L.chart.y + L.chart.h / 2) * s;
      SUBSCRIPTIONS.forEach((sub, i) => {
        const outer = (110 - i * 13) * s;
        canvas.fillRing(cx, cy, outer - 11 * s, outer, hsl(sub.hue, 0.7, 0.55));
      });
      SUBSCRIPTIONS.slice(0, 3).forEach((sub, i) => {
        const y = 416 + i * 36;
        canvas.fillRing(40 * s, (y + 12) * s, 0, 7 * s, hsl(sub.hue, 0.7, 0.55));
        text(56, y + 7, 120, 10, ink);
        box({ x: 190, y: y + 5, w: (L.W - 230) * (sub.usd / 40), h: 14 }, 7, hsl(sub.hue, 0.7, 0.55), 0.8);
      });
    }

    // Tab bar.
    box(L.tabBar, 0, white);
    canvas.fillRoundRect(0, L.tabBar.y * s, L.W * s, 1 * s, 0, [216, 216, 220]);
    for (const { tab, frame } of L.tabs) {
      const selected = tab === this.app.tab;
      const color: Rgb = selected ? hsl(accent, 0.75, 0.5) : muted;
      box({ x: frame.x + frame.w / 2 - 13, y: frame.y + 8, w: 26, h: 22 }, 7, color);
      text(frame.x + frame.w / 2 - 18, frame.y + 36, 36, 6, color);
    }
    canvas.fillRoundRect((L.W / 2 - 70) * s, (L.H - 13) * s, 140 * s, 5 * s, 2.5 * s, ink, 0.9);
  }

  /** Tap ripples: a ring that grows and fades over 1.5 s, and a dot at the tap point. */
  private renderTaps(canvas: Canvas): void {
    const s = this.scale;
    const now = Date.now();
    for (const tap of this.taps) {
      const age = (now - tap.at) / 1500;
      if (age >= 1) continue;
      const radius = (12 + age * 40) * s;
      canvas.fillRing(tap.x * s, tap.y * s, radius - 3 * s, radius, [255, 255, 255], 0.9 * (1 - age));
      canvas.fillRing(tap.x * s, tap.y * s, 0, 7 * s, [255, 59, 48], 1 - age);
    }
  }
}

export const createFakeDriver: DriverFactory = async ({ udid, device, log }) => {
  const driver = new FakeDriver(device, log);
  log("info", `FakeDriver ready for ${device?.name ?? udid} (${driver.width} x ${driver.height} pt @${driver.scale}x)`);
  return driver;
};
