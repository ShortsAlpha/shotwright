/**
 * Scroll position of a screen's main list, and scrolling it back to the top.
 *
 * Why: a list root (a tab's navigation root) keeps its scroll offset. An earlier swipe left
 * Renew's Home list 0.5 screens down, so the "all-subscriptions" screenshot had the large title
 * collapsed and rows cut off and blurred under the status bar and the navigation bar (iOS 26
 * scroll-edge effect), in every locale (docs/spikes/explorer.md, "Capture settling and launch
 * latency").
 *
 * Detection uses the accessibility tree only:
 * - the navigation bar on top of the screen; a navigation root has no `BackButton` in it;
 * - the main scroll container: the largest collectionView / table / scrollView / webView that
 *   covers at least half the screen and is not part of a bar;
 * - scrolled: content of that container (cells, texts, buttons, images, ...) sits above the
 *   bottom edge of the navigation bar. At the top, a list starts right below the bar (the large
 *   title is part of the bar).
 */
import type { DeviceDriver, ScreenInfo } from "@shotwright/core";
import { flatten, stableSource, type FlatNode } from "./observe.ts";

const SCROLLERS = new Set(["collectionView", "table", "scrollView", "webView", "outline"]);
const CONTENT = new Set([
  "cell", "staticText", "button", "image", "link", "textField", "searchField", "textView", "switch", "toggle",
  "segmentedControl", "slider", "map", "progressIndicator", "activityIndicator",
]);

export interface ListScroll {
  /** No back button in the navigation bar. */
  readonly root: boolean;
  /** Content of the main list sits above the navigation bar's bottom edge. */
  readonly scrolled: boolean;
  /** The navigation bar's bottom edge, in points. */
  readonly navBottom: number;
  /** The navigation bar's top edge (the status bar is above it), in points. */
  readonly navTop: number;
  /** How far the topmost visible content is above `navBottom` (a lower bound on the scroll offset), in points. */
  readonly offset: number;
  /** The main scroll container, when there is one. */
  readonly container?: FlatNode;
}

function visibleArea(node: FlatNode, screen: ScreenInfo): number {
  const x1 = Math.max(node.frame.x, 0);
  const y1 = Math.max(node.frame.y, 0);
  const x2 = Math.min(node.frame.x + node.frame.w, screen.width);
  const y2 = Math.min(node.frame.y + node.frame.h, screen.height);
  return x2 > x1 && y2 > y1 ? (x2 - x1) * (y2 - y1) : 0;
}

function isDescendant(nodes: readonly FlatNode[], index: number, ancestor: number): boolean {
  for (let p = nodes[index]!.parent; p >= 0; p = nodes[p]!.parent) if (p === ancestor) return true;
  return false;
}

/** The scroll state of the screen's main list, or undefined when there is no navigation bar at the top. */
export function listScrollState(nodes: readonly FlatNode[], screen: ScreenInfo): ListScroll | undefined {
  const navIndex = nodes.findIndex(
    (n) => n.type === "navigationBar" && n.frame.w > screen.width * 0.5 && n.frame.h > 0 && n.frame.y >= 0 && n.frame.y < screen.height * 0.2 && n.frame.h < screen.height * 0.35,
  );
  if (navIndex < 0) return undefined;
  const nav = nodes[navIndex]!;
  const navTop = nav.frame.y;
  const navBottom = nav.frame.y + nav.frame.h;
  const root = !nodes.some((n, i) => n.identifier === "BackButton" && isDescendant(nodes, i, navIndex));
  const screenArea = screen.width * screen.height;
  let containerIndex = -1;
  let best = 0;
  nodes.forEach((n, i) => {
    if (!SCROLLERS.has(n.type) || n.container !== undefined || n.inKeyboard) return;
    const area = visibleArea(n, screen);
    // >= keeps the deepest of nested containers with the same visible area.
    if (area >= screenArea * 0.5 && area >= best) {
      best = area;
      containerIndex = i;
    }
  });
  if (containerIndex < 0) return { root, scrolled: false, navBottom, navTop, offset: 0 };
  let minY = Infinity;
  for (let i = containerIndex + 1; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (!CONTENT.has(n.type) || n.container !== undefined || n.inKeyboard) continue;
    if (n.frame.w <= 0 || n.frame.h <= 0 || n.frame.h > screen.height * 0.6) continue;
    if (n.frame.x + n.frame.w <= 0 || n.frame.x >= screen.width) continue; // off-screen pages of a carousel
    if (!isDescendant(nodes, i, containerIndex)) continue;
    minY = Math.min(minY, n.frame.y);
  }
  const offset = Number.isFinite(minY) ? Math.max(0, navBottom - minY) : 0;
  return { root, scrolled: offset > 2, navBottom, navTop, offset, container: nodes[containerIndex]! };
}

export interface ScrollToTopResult {
  /** "already": nothing to do; "status-bar": a tap on the status bar did it; "swipes": exact drags did; "failed": still scrolled. */
  readonly via: "already" | "status-bar" | "swipes" | "failed" | "no-list";
  readonly swipes: number;
  /** The screen changed. */
  readonly changed: boolean;
  readonly ms: number;
}

export interface ScrollToTopOptions {
  readonly log?: (message: string) => void;
  /** At most this many fallback drags. Default 6. */
  readonly maxSwipes?: number;
}

/**
 * Scrolls the main list back to its top: a tap on the status bar (UIKit's scroll-to-top), then, if
 * the list is still scrolled, drags down by no more than the visible offset each time (momentum-free,
 * so a list with pull-to-refresh is not refreshed by overshooting).
 */
export async function scrollToTop(driver: DeviceDriver, screen: ScreenInfo, bundleId: string, options: ScrollToTopOptions = {}): Promise<ScrollToTopResult> {
  const started = Date.now();
  const log = options.log ?? (() => undefined);
  const look = async () => listScrollState(flatten((await stableSource(driver, bundleId, 10_000, true)).tree), screen);
  let state = await look();
  if (!state?.container) return { via: "no-list", swipes: 0, changed: false, ms: Date.now() - started };
  if (!state.scrolled) return { via: "already", swipes: 0, changed: false, ms: Date.now() - started };
  // The status bar is above the navigation bar; tap left of the Dynamic Island.
  const y = Math.max(4, Math.min(14, state.navTop / 2));
  await driver.tap({ x: Math.round(screen.width * 0.2), y: Math.round(y) });
  await new Promise((r) => setTimeout(r, 400)); // the scroll animation
  state = await look();
  if (state && !state.scrolled) return { via: "status-bar", swipes: 0, changed: true, ms: Date.now() - started };
  const maxSwipes = options.maxSwipes ?? 6;
  let swipes = 0;
  while (state?.scrolled && swipes < maxSwipes) {
    const distance = Math.min(Math.max(state.offset + 8, 40), screen.height * 0.6);
    const from = { x: Math.round(screen.width / 2), y: Math.round(screen.height * 0.3) };
    await driver.swipe({ from, to: { x: from.x, y: Math.round(from.y + distance) }, durationMs: 300 });
    swipes++;
    state = await look();
  }
  const ok = state !== undefined && !state.scrolled;
  if (!ok) log(`scroll to top: still ${Math.round(state?.offset ?? 0)} pt from the top after a status-bar tap and ${swipes} drag(s)`);
  return { via: ok ? "swipes" : "failed", swipes, changed: true, ms: Date.now() - started };
}
