/** The explorer's tools, as provider-neutral JSON-schema specs, plus argument validation. */
import type { JsonSchema } from "@shotwright/muse";

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
}

const reason = { type: "string", description: "Short reason for this action (one sentence), shown to the developer." };
const grid = { type: "integer", minimum: 0, maximum: 1000 };
const point = { type: "object", properties: { x: grid, y: grid }, required: ["x", "y"] };

export const TOOLS: readonly ToolSpec[] = [
  {
    name: "tap",
    description: "Tap an element from the latest observation by its ref (e.g. \"e12\"). Preferred over tap_at.",
    parameters: {
      type: "object",
      properties: { element_id: { type: "string", description: "Element ref from the latest observation, e.g. \"e12\"." }, reason },
      required: ["element_id"],
    },
  },
  {
    name: "tap_at",
    description: "Tap a point on the screenshot, on a 0-1000 grid (x from the left edge, y from the top). Only for things missing from the element list.",
    parameters: { type: "object", properties: { x: grid, y: grid, reason }, required: ["x", "y"] },
  },
  {
    name: "swipe",
    description:
      "Swipe to scroll. `direction` is the finger movement: \"up\" scrolls the content to reveal what is below, \"left\" moves a carousel to the next page. " +
      "Optionally swipe within an element (element_id, e.g. a horizontal list) and set distance (0.1-0.9 of its size, default 0.5). " +
      "Alternatively give from/to points on the 0-1000 grid.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        element_id: { type: "string" },
        distance: { type: "number", minimum: 0.1, maximum: 0.9 },
        from: point,
        to: point,
        reason,
      },
    },
  },
  {
    name: "type_text",
    description: "Type text into the focused text field, or into element_id (tapped first).",
    parameters: { type: "object", properties: { text: { type: "string" }, element_id: { type: "string" }, reason }, required: ["text"] },
  },
  {
    name: "relaunch",
    description: "Terminate and relaunch the app with its demo launch arguments (back to the start screen). Use when stuck or outside the app.",
    parameters: { type: "object", properties: { reason } },
  },
  {
    name: "mark_screen",
    description:
      "Mark the CURRENT screen (the latest observation) as an App Store screenshot candidate. Can be combined with one action in the same turn; the mark applies to the screen before the action.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short kebab-case name, unique, e.g. \"home-overview\"." },
        why: { type: "string", description: "Why this screen sells the app (one or two sentences)." },
        marketing_score: { type: "integer", minimum: 1, maximum: 10, description: "10 = the hero screenshot." },
      },
      required: ["name", "why", "marketing_score"],
    },
  },
  {
    name: "done",
    description: "Finish exploring. List the marked screen names ranked best first (the first three matter most).",
    parameters: {
      type: "object",
      properties: {
        ranked: { type: "array", items: { type: "string" }, description: "Marked screen names, best first." },
        notes: { type: "string", description: "Anything the developer should know (blocked paths, missing demo data, ...)." },
      },
      required: ["ranked", "notes"],
    },
  },
];

export type ToolName = "tap" | "tap_at" | "swipe" | "type_text" | "relaunch" | "mark_screen" | "done";

export type ToolInput =
  | { name: "tap"; elementId: string; reason?: string }
  | { name: "tap_at"; x: number; y: number; reason?: string }
  | {
      name: "swipe";
      direction?: "up" | "down" | "left" | "right";
      elementId?: string;
      distance?: number;
      from?: { x: number; y: number };
      to?: { x: number; y: number };
      reason?: string;
    }
  | { name: "type_text"; text: string; elementId?: string; reason?: string }
  | { name: "relaunch"; reason?: string }
  | { name: "mark_screen"; screenName: string; why: string; score: number }
  | { name: "done"; ranked: string[]; notes: string };

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const pt = (v: unknown) => {
  if (!v || typeof v !== "object") return undefined;
  const x = num((v as { x?: unknown }).x);
  const y = num((v as { y?: unknown }).y);
  return x === undefined || y === undefined ? undefined : { x, y };
};
const ref = (v: unknown) => {
  const s = str(v)?.trim();
  if (!s) return undefined;
  return /^\d+$/.test(s) ? `e${s}` : s.toLowerCase();
};

/** Validates raw tool arguments; returns an error message for the model when they are unusable. */
export function parseToolInput(name: string, args: Record<string, unknown>): ToolInput | { error: string } {
  const reasonText = str(args.reason);
  const withReason = <T extends object>(o: T) => (reasonText ? { ...o, reason: reasonText } : o);
  switch (name) {
    case "tap": {
      const elementId = ref(args.element_id ?? args.id ?? args.element);
      return elementId ? withReason({ name, elementId }) : { error: "tap needs element_id, e.g. \"e3\"" };
    }
    case "tap_at": {
      const x = num(args.x);
      const y = num(args.y);
      return x === undefined || y === undefined ? { error: "tap_at needs integer x and y on the 0-1000 grid" } : withReason({ name, x, y });
    }
    case "swipe": {
      const direction = str(args.direction);
      const from = pt(args.from);
      const to = pt(args.to);
      if (direction && !["up", "down", "left", "right"].includes(direction)) return { error: "direction must be up, down, left or right" };
      if (!direction && !(from && to)) return { error: "swipe needs a direction, or from and to points" };
      const elementId = ref(args.element_id);
      const distance = num(args.distance);
      return withReason({
        name,
        ...(direction ? { direction: direction as "up" | "down" | "left" | "right" } : {}),
        ...(elementId ? { elementId } : {}),
        ...(distance !== undefined ? { distance: Math.min(Math.max(distance, 0.1), 0.9) } : {}),
        ...(from && to ? { from, to } : {}),
      });
    }
    case "type_text": {
      const text = str(args.text);
      const elementId = ref(args.element_id);
      return text === undefined ? { error: "type_text needs text" } : withReason({ name, text, ...(elementId ? { elementId } : {}) });
    }
    case "relaunch":
      return withReason({ name });
    case "mark_screen": {
      const screenName = str(args.name)?.trim();
      const why = str(args.why)?.trim() ?? "";
      const score = Math.round(num(args.marketing_score ?? args.score) ?? 5);
      return screenName ? { name, screenName, why, score: Math.min(Math.max(score, 1), 10) } : { error: "mark_screen needs a name" };
    }
    case "done": {
      const ranked = Array.isArray(args.ranked) ? args.ranked.filter((r): r is string => typeof r === "string") : [];
      return { name, ranked, notes: str(args.notes) ?? "" };
    }
    default:
      return { error: `unknown tool ${name}; use one of ${TOOLS.map((t) => t.name).join(", ")}` };
  }
}

/** Screenshot names in the flow: letters, digits, '.', '_' or '-', at most 64 characters. */
export function sanitizeName(name: string, taken: ReadonlySet<string>): string {
  let base = name
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+/g, "-")
    .replace(/-$/, "")
    .toLowerCase()
    .slice(0, 56);
  if (!base) base = "screen";
  let candidate = base;
  for (let i = 2; taken.has(candidate); i++) candidate = `${base}-${i}`;
  return candidate;
}

/**
 * Extracts a tool call from a plain-text reply: a JSON object like
 * {"tool": "tap", "args": {"element_id": "e3"}} (also "name"/"arguments" or "action" keys).
 */
export function parseJsonAction(text: string): { name: string; args: Record<string, unknown> } | undefined {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/g;
  for (const m of text.matchAll(fenced)) if (m[1]) candidates.push(m[1]);
  // Balanced-brace scan for bare objects.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inString) {
        if (c === "\\") j++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        candidates.push(text.slice(i, j + 1));
        i = j;
        break;
      }
    }
  }
  const names = new Set(TOOLS.map((t) => t.name));
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate) as Record<string, unknown>;
      const name = str(obj.tool) ?? str(obj.name) ?? str(obj.action) ?? str(obj.function);
      if (!name || !names.has(name)) continue;
      const rawArgs = obj.args ?? obj.arguments ?? obj.parameters ?? obj.input;
      const args =
        typeof rawArgs === "string"
          ? (JSON.parse(rawArgs) as Record<string, unknown>)
          : rawArgs && typeof rawArgs === "object"
            ? (rawArgs as Record<string, unknown>)
            : Object.fromEntries(Object.entries(obj).filter(([k]) => !["tool", "name", "action", "function"].includes(k)));
      return { name, args };
    } catch {
      // not JSON
    }
  }
  return undefined;
}
