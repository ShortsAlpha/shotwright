/**
 * Smoke test: renders the bundled fixture into every set and template (plus RTL and CJK captions),
 * checks exact pixel sizes and that no image has an alpha channel, prints timings.
 * Exit code 1 on any failure. Use it to check a new machine or the Docker image.
 *
 *   node packages/render/scripts/smoke.ts [--out <dir>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SCREENSHOT_SETS, SCREENSHOT_SET_IDS } from "@shotwright/core";
import sharp from "sharp";
import { TEMPLATE_IDS, createRenderer, type RenderJob } from "../src/index.ts";

const { values } = parseArgs({ options: { out: { type: "string" } } });
const out = values.out ?? join(tmpdir(), "shotwright-render-smoke");
mkdirSync(out, { recursive: true });
const capture = fileURLToPath(new URL("../fixtures/renew-home-en.png", import.meta.url));

const captions: [string, string][] = [
  ["en", "All renewals *at a glance*"],
  ["ar", "لا تفوّت أي تجديد"],
  ["ja", "すべての更新をひと目で"],
];
const jobs: RenderJob[] = [];
for (const set of SCREENSHOT_SET_IDS)
  for (const template of TEMPLATE_IDS)
    captions.forEach(([locale, caption], index) => jobs.push({ set, template, capture, caption, locale, index, total: captions.length }));

const renderer = await createRenderer();
const t0 = performance.now();
let failures = 0;
try {
  const results = await renderer.renderMany(jobs);
  for (const [i, r] of results.entries()) {
    const j = jobs[i]!;
    const meta = await sharp(r.bytes).metadata();
    const want = SCREENSHOT_SETS[j.set].portrait;
    const ok = meta.width === want.width && meta.height === want.height && !meta.hasAlpha && meta.channels === 3 && (r.caption?.fits ?? false);
    if (!ok) failures++;
    const file = join(out, `${j.set}_${j.template}_${j.locale}.png`);
    writeFileSync(file, r.bytes);
    console.log(
      `${ok ? "ok  " : "FAIL"} ${j.set.padEnd(17)} ${j.template!.padEnd(11)} ${j.locale} ${meta.width}x${meta.height} ch=${meta.channels} ` +
        `alpha=${meta.hasAlpha} caption=${r.caption?.fontSize}px/${r.caption?.lines}L ${Math.round(r.ms.total)} ms`,
    );
  }
} finally {
  await renderer.close();
}
const wall = performance.now() - t0;
console.log(`${jobs.length - failures}/${jobs.length} ok, ${(wall / 1000).toFixed(1)} s (${Math.round(wall / jobs.length)} ms/image), images in ${out}`);
process.exit(failures ? 1 : 0);
