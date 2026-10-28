/**
 * App Store asset specs (the asset matrix in PLAN.md).
 *
 * Screenshot sizes are stored in portrait; the landscape size is the same
 * pair swapped (see `screenshotSize`).
 */

export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

export interface DurationRange {
  readonly minSeconds: number;
  readonly maxSeconds: number;
}

export type Orientation = "portrait" | "landscape";
export type MediaKind = "image" | "video";

// --- Screenshot sets ---------------------------------------------------------

export type ScreenshotSetId =
  | "iphone-6.3"
  | "ipad-13"
  | "iphone-duo-outer"
  | "iphone-duo-inner";

export interface ScreenshotSetSpec {
  readonly id: ScreenshotSetId;
  readonly label: string;
  readonly family: "iphone" | "ipad";
  /** Exact pixel size in portrait. */
  readonly portrait: PixelSize;
  /** Month (YYYY-MM) from which App Store Connect requires this set, if announced. */
  readonly requiredFrom?: string;
  readonly note?: string;
}

export const SCREENSHOT_SETS = {
  "iphone-6.3": {
    id: "iphone-6.3",
    label: 'iPhone 6.3"',
    family: "iphone",
    portrait: { width: 1206, height: 2622 },
    note: "Apple's required iPhone set (Dynamic Island, medium display); captured on an iPhone 17 Pro simulator",
  },
  "ipad-13": {
    id: "ipad-13",
    label: 'iPad 13"',
    family: "ipad",
    portrait: { width: 2064, height: 2752 },
  },
  "iphone-duo-outer": {
    id: "iphone-duo-outer",
    label: "iPhone Duo (outer display)",
    family: "iphone",
    portrait: { width: 1398, height: 2034 },
  },
  "iphone-duo-inner": {
    id: "iphone-duo-inner",
    label: "iPhone Duo (inner display)",
    family: "iphone",
    portrait: { width: 2007, height: 2853 },
    requiredFrom: "2027-04",
    note: "Mandatory from April 2027 (iOS 27.1 SDK)",
  },
} as const satisfies { readonly [K in ScreenshotSetId]: ScreenshotSetSpec & { readonly id: K } };

export const SCREENSHOT_SET_IDS = Object.keys(SCREENSHOT_SETS) as ScreenshotSetId[];

/** Maximum screenshots per set and locale. */
export const MAX_SCREENSHOTS_PER_SET = 10;

export function screenshotSize(set: ScreenshotSetId, orientation: Orientation = "portrait"): PixelSize {
  const { width, height } = SCREENSHOT_SETS[set].portrait;
  return orientation === "portrait" ? { width, height } : { width: height, height: width };
}

// --- App previews ------------------------------------------------------------

export const APP_PREVIEW = {
  duration: { minSeconds: 15, maxSeconds: 30 },
  maxPerSet: 3,
} as const satisfies { duration: DurationRange; maxPerSet: number };

// --- Product page header -----------------------------------------------------

export const PRODUCT_PAGE_HEADER = {
  /** 21:9 */
  size: { width: 3840, height: 1646 },
  media: ["image", "video"],
  videoDuration: { minSeconds: 5, maxSeconds: 30 },
} as const satisfies {
  size: PixelSize;
  media: readonly MediaKind[];
  videoDuration: DurationRange;
};

// --- Search results ----------------------------------------------------------

export const SEARCH_RESULTS = {
  aspectRatio: { width: 3, height: 2 },
  minSize: { width: 1920, height: 1280 },
  maxSize: { width: 3840, height: 2560 },
  media: ["image", "video"],
  /** Same 5-30 s loop as the header (PLAN.md pipeline step 6). */
  videoDuration: { minSeconds: 5, maxSeconds: 30 },
  /** Search results videos always play muted. */
  videoMuted: true,
} as const satisfies {
  aspectRatio: PixelSize;
  minSize: PixelSize;
  maxSize: PixelSize;
  media: readonly MediaKind[];
  videoDuration: DurationRange;
  videoMuted: boolean;
};
