/**
 * A recorded flow: the path from app launch to each marketing screen,
 * replayed for every device and locale.
 *
 * Steps target elements by accessibility identifier or label so they survive
 * different screen sizes and languages. Elements without an identifier also
 * carry their structural position (type, index among same-type siblings,
 * normalized frame), which survives a language switch when the label does not.
 * Coordinates are only a fallback and are normalized (0..1, origin top-left)
 * so they scale across devices.
 *
 * Locale, appearance and status bar are applied by the replayer per run;
 * they are not part of the flow.
 */
import * as z from "zod";

const nonEmpty = z.string().min(1);

export const NormalizedPointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

/** A rectangle in normalized screen coordinates (0..1, origin top-left). */
export const NormalizedRectSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});

export const ElementSelectorSchema = z
  .object({
    /** `accessibilityIdentifier` (preferred: stable across locales). */
    id: nonEmpty.optional(),
    /** `accessibilityLabel` (localized; used when the element has no identifier). */
    label: nonEmpty.optional(),
    /** Element type as the UI driver reports it, e.g. "button", "cell", "segmentedControl". */
    type: nonEmpty.optional(),
    /**
     * Position among the siblings of the same `type` in the parent element, 0-based. Structural
     * replay matches type + index + a frame near `frame` before trying the (localized) label.
     * Not the runner's `index` (n-th match of the whole query): drivers ignore it.
     */
    index: z.number().int().min(0).optional(),
    /** The element's frame when recorded, normalized to the screen. */
    frame: NormalizedRectSchema.optional(),
  })
  .refine((s) => s.id !== undefined || s.label !== undefined || s.type !== undefined, {
    message: "Selector needs an accessibility identifier, a label or an element type",
  });

export const LaunchStepSchema = z.object({
  action: z.literal("launch"),
  bundleId: z
    .string()
    .regex(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/, "Expected a bundle identifier like com.example.app"),
  /** Launch arguments, e.g. ["-ShotwrightDemo", "YES"]. */
  args: z.array(z.string()).default([]),
});

export const TapStepSchema = z
  .object({
    action: z.literal("tap"),
    /** The element to tap. Omit for a coordinate-only tap (then `point` is required). */
    target: ElementSelectorSchema.optional(),
    /** Used only when the target cannot be found. */
    fallback: NormalizedPointSchema.optional(),
    /** Coordinate-only tap: the point to tap when there is no element to name. */
    point: NormalizedPointSchema.optional(),
  })
  .refine((s) => s.target !== undefined || s.point !== undefined, {
    message: "Tap needs a target element or a point",
  });

export const SwipeStepSchema = z.object({
  action: z.literal("swipe"),
  direction: z.enum(["up", "down", "left", "right"]),
  /** Element to swipe within; the whole screen when omitted. */
  target: ElementSelectorSchema.optional(),
  /** Swipe length as a fraction of the target (or screen) size. */
  distance: z.number().gt(0).max(1).default(0.5),
  /** Where the finger starts; centred on the target (or screen) when omitted. */
  from: NormalizedPointSchema.optional(),
});

export const TypeTextStepSchema = z.object({
  action: z.literal("typeText"),
  text: z.string(),
  /** Field to tap before typing; types into the focused field when omitted. */
  target: ElementSelectorSchema.optional(),
});

export const WaitForStepSchema = z.object({
  action: z.literal("waitFor"),
  target: ElementSelectorSchema,
  timeoutMs: z.number().int().positive().max(120_000).default(10_000),
});

/**
 * What a screenshot step should show, so a flow can verify itself in any locale without the
 * exploration that recorded it. Everything here is language-independent except `title`.
 */
export const ExpectedScreenSchema = z.object({
  /** Accessibility identifiers that must all be visible. */
  ids: z.array(nonEmpty).max(16).default([]),
  /** The screen title when recorded (localized): context for people and repair, not checked. */
  title: z.string().max(200).optional(),
  /** Element types of the recorded screen, in order; compared by sequence similarity. */
  structure: z.array(nonEmpty).max(200).optional(),
});

export const ScreenshotStepSchema = z.object({
  action: z.literal("screenshot"),
  /** Used in output file names, e.g. "01-home". */
  name: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Use letters, digits, '.', '_' or '-'")
    .max(64),
  expect: ExpectedScreenSchema.optional(),
});

export const FlowStepSchema = z.discriminatedUnion("action", [
  LaunchStepSchema,
  TapStepSchema,
  SwipeStepSchema,
  TypeTextStepSchema,
  WaitForStepSchema,
  ScreenshotStepSchema,
]);

export const FlowSchema = z
  .object({
    version: z.literal(1),
    name: nonEmpty,
    steps: z.array(FlowStepSchema).min(1),
  })
  .superRefine((flow, ctx) => {
    const seen = new Set<string>();
    flow.steps.forEach((step, index) => {
      if (step.action !== "screenshot") return;
      if (seen.has(step.name)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate screenshot name "${step.name}"`,
          path: ["steps", index, "name"],
        });
      }
      seen.add(step.name);
    });
  });

export type NormalizedPoint = z.infer<typeof NormalizedPointSchema>;
export type NormalizedRect = z.infer<typeof NormalizedRectSchema>;
export type ElementSelector = z.infer<typeof ElementSelectorSchema>;
export type LaunchStep = z.infer<typeof LaunchStepSchema>;
export type TapStep = z.infer<typeof TapStepSchema>;
export type SwipeStep = z.infer<typeof SwipeStepSchema>;
export type TypeTextStep = z.infer<typeof TypeTextStepSchema>;
export type WaitForStep = z.infer<typeof WaitForStepSchema>;
export type ExpectedScreen = z.infer<typeof ExpectedScreenSchema>;
export type ScreenshotStep = z.infer<typeof ScreenshotStepSchema>;
export type FlowStep = z.infer<typeof FlowStepSchema>;
export type FlowAction = FlowStep["action"];
/** A parsed flow (defaults applied). */
export type Flow = z.infer<typeof FlowSchema>;
/** A flow as written in JSON (defaults optional). */
export type FlowInput = z.input<typeof FlowSchema>;
