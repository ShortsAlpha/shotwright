/**
 * Observation: what the model sees at each step.
 *
 * - A compact accessibility list: one line per useful visible element, with a short ref
 *   (e1, e2, ...) the model uses in tool calls, the element's type, label, identifier and centre
 *   on a 0-1000 grid (the grid Muse uses for visual grounding).
 * - The screenshot downscaled to point size (402 x 874 on the iPhone 6.3"), as JPEG.
 *
 * Also computes a structural fingerprint (to recognise screens again) and a locale-independent
 * structure signature (to verify replays in other languages).
 */
import { createHash } from "node:crypto";
import type { DeviceDriver, Rect, ScreenInfo, UINode, UISnapshot } from "@shotwright/core";
import sharp from "sharp";

export interface FlatNode {
  readonly type: string;
  readonly identifier?: string;
  readonly label?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly frame: Rect;
  readonly enabled: boolean;
  readonly selected: boolean;
  readonly depth: number;
  /** Nearest navigationBar / tabBar / toolbar / alert / sheet ancestor. */
  readonly container?: string;
  readonly inKeyboard: boolean;
}

export interface ObservedElement extends FlatNode {
  readonly ref: string;
}

export interface Observation {
  readonly index: number;
  readonly screen: ScreenInfo;
  readonly snapshot: UISnapshot;
  readonly nodes: readonly FlatNode[];
  readonly elements: readonly ObservedElement[];
  /** The compact list for the model. */
  readonly text: string;
  /** One line for older turns, when the full observation is no longer sent. */
  readonly summary: string;
  readonly fingerprint: string;
  /** One "type|identifier|label" line per element: what the fingerprint hashes, kept to compare screens. */
  readonly lines: readonly string[];
  /** Locale-independent shape: element types of the compact list, in order. */
  readonly structure: readonly string[];
  /** Visible, locale-independent accessibility identifiers (see stableIdentifiers), in tree order. */
  readonly identifiers: readonly string[];
  /** The same identifiers, best `waitFor` anchors first (views and controls before SF Symbol images). */
  readonly anchorIds: readonly string[];
  readonly title: string | undefined;
  readonly keyboard: boolean;
  readonly foreground: boolean;
  /** Full-resolution PNG from the driver. */
  readonly png: Uint8Array;
  /** Downscaled JPEG sent to the model. */
  readonly image: Uint8Array;
}

const INTERACTIVE = new Set([
  "button", "cell", "link", "textField", "secureTextField", "searchField", "textView", "switch", "toggle",
  "slider", "stepper", "segmentedControl", "picker", "pickerWheel", "datePicker", "tab", "menuItem",
  "menuButton", "popUpButton", "checkBox", "radioButton", "pageIndicator", "incrementArrow", "decrementArrow",
]);
const CONTAINERS = new Set(["navigationBar", "tabBar", "toolbar", "alert", "sheet", "popover"]);
const MAX_ELEMENTS = 140;
const MAX_LABEL = 80;

export function isInteractive(type: string): boolean {
  return INTERACTIVE.has(type);
}

/** Flattens the snapshot tree, depth-first, keeping container context. */
export function flatten(tree: UINode): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (node: UINode, depth: number, container: string | undefined, inKeyboard: boolean) => {
    const keyboard = inKeyboard || node.type === "keyboard";
    out.push({
      type: node.type,
      ...(node.identifier ? { identifier: node.identifier } : {}),
      ...(node.label ? { label: node.label } : {}),
      ...(node.value ? { value: node.value } : {}),
      ...(node.placeholder ? { placeholder: node.placeholder } : {}),
      frame: node.frame,
      enabled: node.enabled,
      selected: node.selected ?? false,
      depth,
      ...(container ? { container } : {}),
      inKeyboard: keyboard,
    });
    const next = CONTAINERS.has(node.type) ? node.type : container;
    for (const child of node.children ?? []) walk(child, depth + 1, next, keyboard);
  };
  walk(tree, 0, undefined, false);
  return out;
}

export function center(frame: Rect): { x: number; y: number } {
  return { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
}

export function onScreen(frame: Rect, screen: ScreenInfo): boolean {
  const c = center(frame);
  return frame.w > 0 && frame.h > 0 && c.x >= 0 && c.y >= 0 && c.x <= screen.width && c.y <= screen.height;
}

/** Frames of the bars that float over scrolling content: tab bars and navigation bars. */
export function overlayFrames(nodes: readonly FlatNode[], screen: ScreenInfo): Rect[] {
  return nodes
    .filter((n) => (n.type === "tabBar" || n.type === "navigationBar") && onScreen(n.frame, screen) && n.frame.h < screen.height * 0.25)
    .map((n) => n.frame);
}

/**
 * On screen and not covered by a tab bar or navigation bar it does not belong to. A list row that
 * has scrolled under the floating tab bar is "on screen", but a tap on it hits the tab bar.
 */
export function tappable(node: FlatNode, overlays: readonly Rect[], screen: ScreenInfo): boolean {
  if (!onScreen(node.frame, screen)) return false;
  if (node.container === "tabBar" || node.container === "navigationBar" || node.type === "tabBar" || node.type === "navigationBar") return true;
  const c = center(node.frame);
  return !overlays.some((f) => c.x >= f.x && c.x <= f.x + f.w && c.y >= f.y && c.y <= f.y + f.h);
}

export function toGrid(point: { x: number; y: number }, screen: ScreenInfo): { x: number; y: number } {
  return { x: Math.round((point.x / screen.width) * 1000), y: Math.round((point.y / screen.height) * 1000) };
}

export function fromGrid(point: { x: number; y: number }, screen: ScreenInfo): { x: number; y: number } {
  const clamp = (v: number) => Math.min(Math.max(v, 0), 1000);
  return { x: (clamp(point.x) / 1000) * screen.width, y: (clamp(point.y) / 1000) * screen.height };
}

const clip = (s: string) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s).replace(/\s+/g, " ");

/** Picks the elements worth showing: interactive, identified, or text that adds information. */
export function selectElements(nodes: readonly FlatNode[], screen: ScreenInfo): FlatNode[] {
  const picked: FlatNode[] = [];
  const overlays = overlayFrames(nodes, screen);
  // Per depth: the label of an included ancestor, and whether it is interactive. Texts and images
  // inside a kept button or cell are part of it (its label already combines them).
  const ancestors: Array<{ label: string | undefined; interactive: boolean } | undefined> = [];
  for (const node of nodes) {
    ancestors.length = node.depth;
    if (node.depth === 0 || node.inKeyboard) continue; // the application element; keyboard keys
    if (!tappable(node, overlays, screen)) continue;
    const label = node.label?.trim();
    const meaningful = label !== undefined && /[\p{L}\p{N}]/u.test(label);
    const isText = node.type === "staticText" || node.type === "image" || node.type === "textView";
    const lower = label?.toLowerCase();
    const insideInteractive = ancestors.some((a) => a?.interactive);
    const repeated = lower !== undefined && ancestors.some((a) => a?.label !== undefined && a.label.toLowerCase().includes(lower));
    let keep = false;
    if (isInteractive(node.type)) keep = Boolean(meaningful || node.identifier || node.value || node.placeholder);
    else if (node.type === "tabBar" || node.type === "toolbar") keep = false; // their buttons say in:tabBar
    else if (CONTAINERS.has(node.type)) keep = Boolean(label || node.identifier);
    else if (isText) keep = meaningful && !repeated && !insideInteractive;
    else keep = Boolean(node.identifier) && !insideInteractive; // containers the developer named, e.g. "subscription.detail"
    if (node.type === "image" && !meaningful) keep = false;
    if (keep) picked.push(node);
    ancestors[node.depth] = keep ? { label, interactive: isInteractive(node.type) } : undefined;
  }
  return picked;
}

function line(el: ObservedElement, screen: ScreenInfo): string {
  const g = toGrid(center(el.frame), screen);
  let s = `${el.ref} ${el.type}`;
  if (el.label) s += ` "${clip(el.label)}"`;
  if (el.identifier) s += ` #${el.identifier}`;
  if (el.value && el.value !== el.label) s += ` value="${clip(el.value)}"`;
  if (el.placeholder && !el.value) s += ` placeholder="${clip(el.placeholder)}"`;
  s += ` (${g.x},${g.y})`;
  if (!el.enabled) s += " disabled";
  if (el.selected) s += " selected";
  if (el.container && el.container !== el.type) s += ` in:${el.container}`;
  return s;
}

export interface ObserveOptions {
  readonly bundleId: string;
  readonly screen: ScreenInfo;
  readonly index: number;
  /** Model image width relative to the point size. Default 1 (402 px wide on the iPhone 6.3"). */
  readonly imageScale?: number;
  readonly jpegQuality?: number;
}

/** Polls `source()` until two consecutive snapshots have the same structure (or uses the driver's own wait). */
export async function stableSource(driver: DeviceDriver, bundleId: string, timeoutMs = 10_000): Promise<UISnapshot> {
  const withWait = driver as DeviceDriver & { waitForStable?: (o: { bundleId?: string; timeoutMs?: number }) => Promise<UISnapshot> };
  if (typeof withWait.waitForStable === "function") return withWait.waitForStable({ timeoutMs });
  const start = Date.now();
  let last = "";
  let snapshot = await driver.source(bundleId);
  for (;;) {
    const hash = structureHash(snapshot.tree);
    if (hash === last || Date.now() - start > timeoutMs) return snapshot;
    last = hash;
    await new Promise((r) => setTimeout(r, 300));
    snapshot = await driver.source(bundleId);
  }
}

function structureHash(tree: UINode): string {
  return createHash("sha1").update(flatten(tree).map((n) => `${n.type}|${n.identifier ?? ""}|${n.label ?? ""}|${n.frame.x},${n.frame.y},${n.frame.w},${n.frame.h}`).join("\n")).digest("hex");
}

/**
 * Visible identifiers that do not depend on the language: UIKit names a navigation bar after its
 * (localized) title, and some views use their label as identifier, so those are left out.
 */
export function stableIdentifiers(nodes: readonly FlatNode[], screen: ScreenInfo): string[] {
  const labels = new Set(nodes.map((n) => n.label).filter((l): l is string => Boolean(l)));
  return [
    ...new Set(
      nodes
        .filter((n) => n.identifier && !n.inKeyboard && n.type !== "navigationBar" && onScreen(n.frame, screen))
        .map((n) => n.identifier!)
        .filter((id) => !/\s/.test(id) && !labels.has(id)),
    ),
  ];
}

export async function downscale(png: Uint8Array, width: number, height: number, quality = 72): Promise<Uint8Array> {
  const out = await sharp(png).resize(Math.round(width), Math.round(height), { fit: "fill" }).jpeg({ quality, mozjpeg: true }).toBuffer();
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/** Builds an observation from a snapshot and a screenshot (no device calls). */
export async function buildObservation(snapshot: UISnapshot, png: Uint8Array, options: ObserveOptions): Promise<Observation> {
  const { screen } = options;
  const nodes = flatten(snapshot.tree);
  const picked = selectElements(nodes, screen).slice(0, MAX_ELEMENTS);
  const elements: ObservedElement[] = picked.map((node, i) => ({ ...node, ref: `e${i + 1}` }));
  const keyboard = nodes.some((n) => n.type === "keyboard" && onScreen(n.frame, screen));
  const foreground = snapshot.state === "foreground";
  const navBar = nodes.find((n) => n.type === "navigationBar" && onScreen(n.frame, screen) && (n.identifier || n.label));
  const title = navBar ? (navBar.identifier ?? navBar.label) : elements.find((e) => e.type === "staticText")?.label;
  const selectedTab = nodes.find((n) => n.container === "tabBar" && n.selected && n.label)?.label;

  const header = [
    `Screen ${options.index}: ${elements.length} elements${title ? `, title "${clip(title)}"` : ""}${selectedTab ? `, tab "${selectedTab}" selected` : ""}.`,
    foreground ? "" : `The app is not in the foreground (state: ${snapshot.state}). Use relaunch to get back.`,
    keyboard ? "The keyboard is visible." : "",
  ].filter(Boolean);
  const text = [...header, ...elements.map((el) => line(el, screen))].join("\n");
  const summary = `[screen ${options.index}${title ? ` "${clip(title)}"` : ""}, ${elements.length} elements; details omitted]`;

  // Values count for controls whose value is their state (a switch, a filled-in field), not for texts.
  const valued = new Set(["switch", "toggle", "checkBox", "slider", "textField", "searchField", "secureTextField", "segmentedControl"]);
  const lines = elements.map((e) => `${e.type}|${e.identifier ?? ""}|${e.label ?? ""}${valued.has(e.type) ? `|${e.value ?? ""}` : ""}${e.selected ? "|selected" : ""}`);
  const fingerprint = createHash("sha1").update(`${foreground}\n${keyboard}\n${lines.join("\n")}`).digest("hex").slice(0, 16);
  const identifiers = stableIdentifiers(nodes, screen);
  // Anchor candidates: the developer's own identifiers on views and controls first ("subscription.detail"),
  // then system ones (UIKit's PascalCase "BackButton", "Toolbar"), then SF Symbol names on images.
  const onView = (id: string) => nodes.some((n) => n.identifier === id && n.type !== "image");
  const system = (id: string) => /^[A-Z]/.test(id);
  const anchorIds = [
    ...identifiers.filter((id) => onView(id) && !system(id)),
    ...identifiers.filter((id) => onView(id) && system(id)),
    ...identifiers.filter((id) => !onView(id)),
  ];
  const scale = options.imageScale ?? 1;
  const image = await downscale(png, screen.width * scale, screen.height * scale, options.jpegQuality);
  return {
    index: options.index,
    screen,
    snapshot,
    nodes,
    elements,
    text,
    summary,
    fingerprint,
    lines,
    structure: elements.map((e) => e.type),
    identifiers,
    anchorIds,
    title,
    keyboard,
    foreground,
    png,
    image,
  };
}

/** Waits for a stable layout, takes a screenshot and builds the observation. */
export async function observe(driver: DeviceDriver, options: ObserveOptions): Promise<Observation> {
  let snapshot: UISnapshot;
  try {
    snapshot = await stableSource(driver, options.bundleId);
  } catch (error) {
    // The app is not running (crashed, or left): an empty observation the model can react to.
    snapshot = {
      bundleId: options.bundleId,
      state: `unavailable (${(error as Error).message.slice(0, 120)})`,
      count: 0,
      tree: { type: "application", frame: { x: 0, y: 0, w: options.screen.width, h: options.screen.height }, enabled: true },
    };
  }
  const png = await driver.screenshot();
  return buildObservation(snapshot, png, options);
}
