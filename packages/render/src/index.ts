/**
 * @shotwright/render: App Store screenshots from real captures.
 *
 *   const png = await renderScreenshot({ set: "iphone-6.3", template: "caption-top", capture: "home.png",
 *     caption: "All renewals *at a glance*", locale: "en", theme, index: 0, total: 5 });
 *
 *   const results = await renderSet(jobs, { concurrency: 2 });            // one browser for the list
 *   await writeDeliverFolder("out", items); zipDirectory("out", "out/screenshots.zip");
 *
 * See docs/spikes/render.md.
 */
export { createRenderer, renderScreenshot, renderSet } from "./renderer.ts";
export type { CaptionFit, RenderJob, RenderResult, Renderer, RendererOptions } from "./renderer.ts";
export { TEMPLATE_IDS, buildTemplate, captionHtml } from "./templates.ts";
export type { TemplateId, TemplateParams, TemplateOutput, ResolvedBackground } from "./templates.ts";
export { deviceGeometry, deviceHtml, deviceKind, frameOuterSize } from "./frames.ts";
export type { DeviceColor, DeviceGeometry, DeviceKind, FrameStyle } from "./frames.ts";
export { DEFAULT_THEME, contrast, dominantColors, luminance, mix, themeFromIcon } from "./theme.ts";
export type { Background, IconColor, IconTheme, Theme, ThemeFont } from "./theme.ts";
export { ASC_LOCALES, isRtl, localeTypography, scriptForLocale, toAscLocale } from "./locales.ts";
export type { AscLocaleSpec, LocaleTypography, Script } from "./locales.ts";
export { SET_FILE_LABELS, deliverPath, writeDeliverFolder, zipDirectory } from "./deliver.ts";
export type { DeliverItem, DeliverResult } from "./deliver.ts";
export { contactSheet } from "./contact-sheet.ts";
export type { ContactSheetOptions, SheetImage } from "./contact-sheet.ts";
export { bundledFonts, fontFaceCss } from "./fonts.ts";
export type { BundledFont } from "./fonts.ts";
