/**
 * A recorded flow: the path from app launch to each marketing screen,
 * replayed for every device and locale.
 *
 * Steps target elements by accessibility identifier or label so they survive
 * different screen sizes and languages. Coordinates are only a fallback and
 * are normalized (0..1, origin top-left) so they scale across devices.
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

export const ElementSelectorSchema = z
  .object({
    /** `accessibilityIdentifier` (preferred: stable across locales). */
    id: nonEmpty.optional(),
    /** `accessibilityLabel` (localized; used when the element has no identifier). */
    label: nonEmpty.optional(),
  })
  .refine((s) => s.id !== undefined || s.label !== undefined, {
    message: "Selector needs an accessibility identifier or label",
  });

export const LaunchStepSchema = z.object({
  action: z.literal("launch"),
  bundleId: z
    .string()
    .regex(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/, "Expected a bundle identifier like com.example.app"),
  /** Launch arguments, e.g. ["-ShotwrightDemo", "YES"]. */
  args: z.array(z.string()).default([]),
});

export const TapStepSchema = z.object({
  action: z.literal("tap"),
  target: ElementSelectorSchema,
  /** Used only when the target cannot be found. */
  fallback: NormalizedPointSchema.optional(),
});

export const SwipeStepSchema = z.object({
  action: z.literal("swipe"),
  direction: z.enum(["up", "down", "left", "right"]),
  /** Element to swipe within; the whole screen when omitted. */
  target: ElementSelectorSchema.optional(),
  /** Swipe length as a fraction of the target (or screen) size. */
  distance: z.number().gt(0).max(1).default(0.5),
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

export const ScreenshotStepSchema = z.object({
  action: z.literal("screenshot"),
  /** Used in output file names, e.g. "01-home". */
  name: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Use letters, digits, '.', '_' or '-'")
    .max(64),
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
export type ElementSelector = z.infer<typeof ElementSelectorSchema>;
export type LaunchStep = z.infer<typeof LaunchStepSchema>;
export type TapStep = z.infer<typeof TapStepSchema>;
export type SwipeStep = z.infer<typeof SwipeStepSchema>;
export type TypeTextStep = z.infer<typeof TypeTextStepSchema>;
export type WaitForStep = z.infer<typeof WaitForStepSchema>;
export type ScreenshotStep = z.infer<typeof ScreenshotStepSchema>;
export type FlowStep = z.infer<typeof FlowStepSchema>;
export type FlowAction = FlowStep["action"];
/** A parsed flow (defaults applied). */
export type Flow = z.infer<typeof FlowSchema>;
/** A flow as written in JSON (defaults optional). */
export type FlowInput = z.input<typeof FlowSchema>;
