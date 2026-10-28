# Spike: renderer, device frames, captions and deliver export (Oct 28)

Machine: Apple M2, 8 GB RAM, Node 24.15, Playwright 1.64.1 (Chromium headless shell 1248),
sharp 0.35.5. Input: real Renew captures (1320×2868, iPhone 17 Pro Max) from the Oct 28
replays in en, de and ja, with the screen judge's English captions. Captures and renders
stay in the session scratchpad; the repo has one 68 KB downscaled fixture.

## Summary

| Question | Result |
|---|---|
| Exact App Store sizes, no alpha? | **Yes.** 270/270 renders (4 sets × 3 templates × 3 locales × 7 screens, plus 18 extras) checked with `sips`: 1206×2622, 2064×2752, 1398×2034 and 2007×2853, `hasAlpha: no`. Chromium's viewport PNG is already RGB; sharp re-encodes with `removeAlpha()` anyway. |
| Speed | **0.14–0.27 s per image** of wall time with 2 pages in one browser (iPhone and Duo outer about 0.15–0.19 s, iPad and Duo inner about 0.26 s). The full 270-image gallery took 57 s. Browser launch plus first font load takes about 0.5 s, once per renderer. |
| Device frames | Our own SVG: a rounded slab with metal band, black bezel, side buttons and a Dynamic Island (iPhone), camera dot (iPad), hole-punch camera (Duo outer, at the position measured on Simulator captures) and hinge seams (Duo inner). Proportions come from the set's pixel size. No Apple artwork. |
| Templates | `caption-top`, `bleed` (device cut off by the bottom or top edge) and `panorama` (one background strip across the whole set, offset per screenshot and mirrored for RTL). Frame styles: `device`, `none` (frameless rounded screen) and `full-bleed` (raw capture). |
| Captions | Shrink-to-fit in the page: at most 2 lines inside the safe area, `text-wrap: balance`, no overflowing words (a long German compound shrinks instead of overflowing). Japanese breaks at phrases (`word-break: auto-phrase`), Korean at spaces (`keep-all`), Chinese between words (ICU word segmentation → `<wbr>`). RTL for ar/he/fa/ur. Captions that can't fit return a warning. |
| Fonts | Bundled, all OFL-1.1, 4.9 MB: Inter (variable) for Latin, Cyrillic, Greek and Vietnamese; Noto Sans Arabic, Hebrew, Thai, Devanagari and 7 more Indic scripts (variable); Noto Sans JP/KR/SC/TC Bold. Licenses: `packages/render/fonts/LICENSES.md`. |
| Export | `writeDeliverFolder` writes `screenshots/<asc-locale>/<nn>_<set>_<screen>.png`, and `zipDirectory` zips it with no dependencies (`unzip -t` passes). The locale mapping covers all 50 App Store Connect locales. |
| Theme from app icon | `themeFromIcon(png)`: Renew's icon gives `#2666c9` (blue), `#fefeff` (white) and `#e8843b` (the small orange dot), so the theme is a blue gradient, white caption and orange accent. A light variant is also available. |

Contact sheets (scratchpad, `render/`): `contact-sheet.jpg` (overview), `sheet-iphone-{caption-top,bleed,panorama}.jpg`,
`sheet-sets.jpg` (all four sets), `pano-iphone-en.jpg` / `pano-iphone-ar-rtl.jpg` / `pano-ipad-de-solid.jpg`
(panoramas stitched without gaps).

---

## Design

```
RenderJob ─► buildTemplate()  (Node: all geometry in px from the set size)
               │  html + css (absolute layout, SVG frame, <img> capture, caption div)
               ▼
           page.evaluate(renderInPage)        one long-lived page per worker
               swap #root, set lang/dir, document.fonts.load(caption), img.decode(),
               fit captions (shrink 3.5% steps until ≤ maxLines and no overflow)
               ▼
           CDP Page.captureScreenshot (png, optimizeForSpeed) ─► sharp: flatten, removeAlpha, PNG/JPEG
```

- **One browser, a small page pool** (`concurrency`, default 2). Each page loads a shell
  document once; the @font-face rules for every bundled font live in it, so fonts load
  once per page and stay loaded. Per screenshot the page only swaps the DOM, so no navigation
  is needed. The viewport is resized to the set size with `deviceScaleFactor: 1`, so the capture
  is exactly W×H.
- **No network.** The shell, fonts, captures and background images are served to the page from
  memory by a Playwright route on a private origin (`https://render.shotwright.invalid/`).
  `http(s):` background URLs are fetched directly.
- **Geometry in Node, measuring in the page.** Templates compute every box in px. Only caption
  fitting needs the browser: lines are counted from `Range.getClientRects()`, and overflow from
  `scrollWidth`/`scrollHeight`. The fit (font size, lines, fits) comes back in `RenderResult.caption`.
- **Capture fit.** The capture is `object-fit: cover`, anchored at the top, inside a div with the
  device's screen corner radius (`overflow: hidden`). Any capture size works: 1320×2868 and
  1206×2622 differ in aspect by 0.06 %, so they scale cleanly. A capture whose aspect differs from the
  device screen by more than 1.5 % is cropped, and the job gets a warning (seen here when iPhone captures are put
  into the iPad and Duo frames).
- **Shadows** are `box-shadow`s on a rounded rect behind the SVG body. The first version used
  `filter: drop-shadow` on the whole device, which blurred the rasterized layer and doubled the
  render time on the large sets (smoke run 15.3 s → 7.8 s after the change).
- **Chromium flags:** `--force-color-profile=srgb`, `--font-render-hinting=none` and
  `--disable-lcd-text`, so text renders the same on macOS and Linux, plus `--disable-dev-shm-usage` on Linux.

### Device frames (`src/frames.ts`)

All sizes are fractions of the screen width `w` (the set's portrait width):

| Set | Band | Bezel | Screen radius | Extras |
|---|---|---|---|---|
| iPhone 6.3" | 0.0125w | 0.03w | 0.154w (≈62 pt) | Dynamic Island 0.313w × 0.093w, 0.027w from the top; action, volume, power and camera buttons |
| iPad 13" | 0.0065w | 0.042w | 0.03w | camera dot centered in the top bezel; top button, volume on the right |
| Duo outer | 0.0125w | 0.03w | 0.125w | hole-punch camera at (1254, 143), Ø110 px of 1398 (measured on Simulator captures); buttons on the right |
| Duo inner | 0.009w | 0.02w | 0.05w | hinge seams across the band at half height (the portrait inner display folds horizontally) |

Body colors: `dark` (graphite) and `light` (silver) via `theme.deviceColor`. The SVG body sits under
the screen and the island/hole overlay sits on top of it, so the capture's own pixels are
never altered. `deviceHtml()` can be reused on the website for live previews.

## Template gallery

All three take the same parameters: `background` (solid, two-color gradient with an angle, or an image
path/URL/bytes with an optional tint; a Muse Image background drops in here), caption text
(`*emphasis*` is drawn in the accent color, `\n` forces a break), `captionColor`, `font` (any
bundled family, or a custom file via `theme.font.src`), `accent`, `index` and `total`, `frame`
and `deviceColor`.

| Template | Layout |
|---|---|
| `caption-top` | Caption box (2 lines reserved) 5.5 % from the top; the whole framed device below, up to 84 % of the width (80 % on tablets); a soft accent glow behind the device. |
| `bleed` | Device at 90 % of the width (86 % on tablets) with at least 16 % of it cut off. `captionPosition: "top"` (default): caption above, device bleeds off the bottom. `"bottom"`: caption below, device bleeds off the top. The brief said "caption below, device bleeding off the bottom", which can't both hold on one canvas, so both variants exist. |
| `panorama` | Like caption-top, over a strip `total × W` wide, shifted by `index × W`: a gradient running the length of the strip plus two ribbons that cross each seam in the side margins (the device covers the middle), so neighbouring screenshots join up. RTL locales lay the strip out right to left, because the App Store shows screenshot 1 rightmost. |
| frame `none` | Any template, frameless: the capture with the screen corner radius and a shadow. |
| frame `full-bleed` | The capture alone, scaled to cover the canvas, with no caption or background. |

Caption base size is `0.06 × √(W·H)` (×0.92 on tablets), i.e. 107 px on iPhone 6.3" and 132 px on iPad
13". The minimum is 50 % of that. Observed: every judge caption and all the de/ja translations fit in
2 lines in all 252 matrix renders, at 90–100 % of the base size. "Abonnementverwaltungsübersicht" fits on one line at 57 %. A
deliberately long German sentence ends at 3 lines at 50 % and gets a warning.

## Typography

- **Font per locale** (`localeTypography`): the script's font first, then Inter, then
  `sans-serif`. Weights: Inter 800 for Latin; 700 for everything else (CJK only ships 700).
  Line height: 1.1 for Latin, 1.28 for CJK, 1.4 for Arabic/Hebrew/Indic, 1.5 for Thai. Letter-spacing is
  −0.022 em for Latin only (0 for Arabic, which must not be tracked, and for CJK).
- **`lang`** is set on `<html>` (`zh-Hans` / `zh-Hant` for Chinese) so Chromium uses the right
  CJK glyph variants and line-breaking rules. **`dir="rtl"`** for ar, he, fa, ur, ps, sd, ug, yi,
  dv and ckb.
- **CJK line breaking:** ja `word-break: auto-phrase` (Chromium's BudouX phrases, e.g.
  すべての更新を / ひと目で); ko `keep-all`; zh `keep-all` plus `<wbr>` between
  `Intl.Segmenter` words; all with `line-break: strict` (kinsoku).
- Verified visually: Arabic (shaping, shadda, RTL), Hebrew, Thai, Devanagari, Cyrillic, Korean,
  Simplified and Traditional Chinese, Japanese, German.

### Bundled fonts (all SIL OFL 1.1)

| Family | Use | Size |
|---|---|---|
| Inter (variable, 7 subsets) | Latin, Cyrillic, Greek, Vietnamese | 213 KB |
| Noto Sans Arabic / Hebrew / Thai (variable) | ar fa ur / he / th | 162 / 12 / 26 KB |
| Noto Sans Devanagari, Bengali, Gujarati, Gurmukhi, Kannada, Malayalam, Oriya, Tamil, Telugu (variable) | hi mr, bn, gu, pa, kn, ml, or, ta, te | 49–121 KB each |
| Noto Sans JP / KR / SC / TC, Bold | ja / ko / zh-Hans / zh-Hant | 1131 / 546 / 1145 / 997 KB |

Source: Google Fonts, as WOFF2 from Fontsource, fetched by `scripts/fetch-fonts.ts`, which checks
the license field and the WOFF2 magic number and records each file's SHA-256 in `fonts/manifest.json`.
The full OFL text with each family's copyright line is in `fonts/licenses/`. No font is renamed
or modified. Noto CJK's Reserved Font Name "Source" is not used.

## Export layout

```
<out>/screenshots/
  en-US/01_iPhone63_home-overview.png
  en-US/01_ipadPro129_home-overview.png
  en-US/01_iPhoneDuoOuter_home-overview.png
  de-DE/02_iPhone63_calendar-month.png
  ja/…  ar-SA/…  zh-Hans/…  pt-BR/…
<out>/screenshots.zip   (entries under screenshots/)
```

- `toAscLocale`: exact App Store Connect codes pass through. A bare language gets its default
  (en→en-US, de→de-DE, fr→fr-FR, es→es-ES, pt→pt-BR, nl→nl-NL, ar→ar-SA, zh→zh-Hans; nb/nn→no, iw→he,
  in→id). Missing regions map to the nearest locale (en-NZ→en-AU, en-IE/IN→en-GB, es-419/es-US→es-MX,
  zh-TW/HK/MO→zh-Hant), and languages the App Store doesn't offer (e.g. `fa`) throw. The list has 39 long-standing
  locales plus 11 added in 2025 (bn-BD, gu-IN, kn-IN, ml-IN, mr-IN, or-IN, pa-IN, sl-SI, ta-IN, te-IN,
  ur-PK), flagged `added2025`. Check those 11 against your fastlane version.
- `deliver` gets the display type from the pixel size and the order from the sorted file names.
  `ipadPro129` in the iPad name is the marker fastlane uses for 12.9"/13" iPad Pro shots.
- `zipDirectory` is a ~100-line ZIP writer (`zlib.crc32`, stored PNGs, deflated others, UTF-8
  names). It doesn't depend on the system `zip`, which a slim Docker image may lack. There is no ZIP64, so it stops at
  4 GiB / 65,535 entries. A full 40-locale × 4-set × 10-screen export is about 1.6k files and about 1.2 GB.

## Timings

Per image, wall time divided by count, after warm-up, `caption-top`, 7 Renew screens per set:

| Set | 1 page | 2 pages (default) | 3 pages |
|---|---|---|---|
| iPhone 6.3" 1206×2622 | 271 ms | 189 ms | 208 ms |
| iPad 13" 2064×2752 | 501 ms | 274 ms | 248 ms |
| Duo outer 1398×2034 | 294 ms | 141 ms | 143 ms |
| Duo inner 2007×2853 | 442 ms | 257 ms | 231 ms |

With 1 page, the iPhone time splits into about 36 ms DOM, fonts and caption fit; 160 ms Chromium capture (with raster);
and 75 ms sharp PNG re-encode. The iPad splits into 51, 296 and 154 ms. A third page doesn't help on 8 GB / M2. Full gallery: 270 images
in 57 s (211 ms/image). PNGs are 0.4–0.8 MB (iPhone, Duo outer) and 0.7–1.4 MB (iPad, Duo inner).

## API

```ts
import { renderScreenshot, renderSet, createRenderer, themeFromIcon, writeDeliverFolder, zipDirectory } from "@shotwright/render";

const { theme } = await themeFromIcon("AppIcon-1024.png");            // or a Theme literal
const png = await renderScreenshot({ set: "iphone-6.3", template: "caption-top", capture: "home.png",
  caption: "All renewals *at a glance*", locale: "en", theme, index: 0, total: 5 });   // Buffer (PNG)

const results = await renderSet(jobs, { concurrency: 2 });   // one browser; RenderResult { bytes, ms, caption, warnings }
// long-lived (web server): const r = await createRenderer(); await r.render(job); … await r.close();

await writeDeliverFolder("out", results.map((r, i) => ({ locale, set, screen, position: i + 1, bytes: r.bytes })));
zipDirectory("out/screenshots", "out/screenshots.zip", { prefix: "screenshots" });
```

`RenderJob`: `set`, `capture` (bytes or path), `template?`, `caption?`, `locale?`, `theme?`,
`index?`, `total?`, `frame?`, `captionPosition?`, `maxLines?` (2), `format?` (`png`|`jpeg`),
`jpegQuality?`, `shadow?`. Also exported: `deviceGeometry` / `deviceHtml`, `buildTemplate`,
`localeTypography` / `isRtl` / `toAscLocale` / `ASC_LOCALES`, `dominantColors`, `contactSheet`,
and color helpers (`contrast`, `luminance`, `mix`).

## Commands

```sh
npm install                                   # adds playwright + sharp to @shotwright/render
npx playwright install --only-shell chromium  # macOS; ~/Library/Caches/ms-playwright
# Linux / Docker (Railway): system libraries + headless shell
npx playwright install --with-deps --only-shell chromium

npm run smoke -w @shotwright/render -- --out /tmp/smoke      # 36 renders, checks size/alpha/fit, exit 1 on failure
node packages/render/scripts/render.ts --spec spec.json --captures <replay dir> --out <dir> --zip --sheet
npm run fonts:fetch -w @shotwright/render                    # re-download fonts (only to update them)
```

The CLI reads captures from `<dir>/<set>/<locale>/<screen>.png`, falling back to
`<dir>/<locale>/<screen>.png` (the explorer's replay output). The spec format is documented at the top of
`scripts/render.ts`. Example run: 5 screens × en/de/ja × iPhone + iPad, panorama, theme from
the icon: 30 files in 11.2 s, 22.5 MB zip.

## Known limitations

- **Portrait only.** `screenshotSize(set, "landscape")` exists in core, but frames and templates
  are portrait. Landscape iPad shots need a rotated frame and their own layouts.
- **No real iPad or Duo captures were available**, so those sets were checked with the iPhone
  captures, cropped to cover. The frame and screen proportions match the native set sizes, so real
  captures should drop in. The Duo outer status bar sits under the hole-punch camera on real captures, which
  is why the hole is drawn where the Simulator puts it.
- **CJK fonts are language subsets** (the common characters of each language, the Google Fonts
  `japanese` / `korean` / `chinese-*` subset), in Bold only. A rare character falls back to a system font. That's
  fine on macOS, but a bare Linux image would show tofu, so add `fonts-noto-cjk` to the Docker image as a
  safety net. There is no glyph-coverage check yet.
- **Urdu** uses Noto Sans Arabic (Naskh style). Readers usually expect Nastaliq; Noto Nastaliq Urdu
  would be the proper font.
- **No hyphenation**, deliberately: long words shrink the caption instead, because Chromium's
  hyphenation dictionaries are not reliably available on Linux. Authors can add soft hyphens (`&shy;`).
- **Captions that don't fit** in `maxLines` at 50 % size still render (wrapping onto an extra
  line) and return a warning. The caller (Muse) should shorten them; there is no automatic retry yet.
- **Chinese word segmentation** comes from ICU's dictionary and sometimes splits a measure word
  (每一 / 筆). The break is legal but not the most natural one.
- The ZIP writer has no ZIP64 (4 GiB cap) and builds each entry in memory (one PNG at a time).
- Some `deliver` details are not verified against a live fastlane run (no App Store Connect upload in this
  spike): the `ipadPro129` marker, the 2025 locale codes, and how deliver handles the new Duo sizes it doesn't know.

## Files

```
packages/render/
  src/renderer.ts        engine: browser, page pool, routes, caption fit, capture, encode
  src/templates.ts       caption-top, bleed, panorama, full-bleed; captionHtml (escape, *accent*, zh <wbr>)
  src/frames.ts          SVG device frames and geometry per set
  src/locales.ts         ASC locales and mapping, RTL, script, font stack, line breaking
  src/theme.ts           Theme, backgrounds, dominantColors, themeFromIcon, color helpers
  src/deliver.ts         writeDeliverFolder, deliverPath, zipDirectory
  src/contact-sheet.ts   contactSheet (sharp)
  src/fonts.ts           @font-face CSS from fonts/manifest.json
  scripts/render.ts      CLI: captures folder + JSON spec → deliver folder, zip, contact sheet
  scripts/smoke.ts       fixture → every set × template × (en, ar, ja), validates output
  scripts/fetch-fonts.ts downloads fonts and licenses, writes manifest.json and LICENSES.md
  fonts/                 files/*.woff2 (4.9 MB), licenses/*-OFL.txt, manifest.json, LICENSES.md
  fixtures/renew-home-en.png  603×1310 Renew capture (68 KB)
```

Not in core yet (kept in `packages/render/src/locales.ts`, to move when the web app needs them):
`ASC_LOCALES`, `toAscLocale`, `isRtl`, `scriptForLocale`.
