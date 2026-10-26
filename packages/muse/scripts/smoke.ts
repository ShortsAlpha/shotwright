/**
 * Smoke test: send one screenshot to muse-spark-1.3 and print its description.
 * Costs real money (roughly a tenth of a cent per run), so it is never run in CI.
 *
 *   node packages/muse/scripts/smoke.ts path/to/screenshot.png
 *   npm run smoke -w @shotwright/muse -- path/to/screenshot.png
 *
 * Reads MUSE_API_KEY from the repo root's .env.local.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS, MuseClient, userMessage } from '../src/index.ts';

const envFile = fileURLToPath(new URL('../../../.env.local', import.meta.url));
const screenshotArg = process.argv[2];
if (!screenshotArg) {
  console.error('usage: node packages/muse/scripts/smoke.ts <screenshot.png>');
  process.exit(2);
}

try {
  process.loadEnvFile(envFile);
} catch {
  console.error(`could not read ${envFile}`);
  process.exit(2);
}
const apiKey = process.env.MUSE_API_KEY;
if (!apiKey) {
  console.error(`MUSE_API_KEY is not set in ${envFile}`);
  process.exit(2);
}

// `npm run -w` changes cwd to the package; resolve the path against where the user ran it.
const screenshotPath = resolve(process.env.INIT_CWD ?? process.cwd(), screenshotArg);
const png = await readFile(screenshotPath);

const muse = new MuseClient({ apiKey });
const result = await muse.chat({
  model: MODELS.spark,
  reasoning_effort: 'low',
  messages: [
    { role: 'developer', content: 'You are looking at a screenshot of an iOS app running in the iOS Simulator.' },
    userMessage(
      'Describe this screen: what app and which screen it is, the main UI elements from top to bottom, and what a user can do here.',
      png,
    ),
  ],
});

console.log(result.text);

const usage = result.usage;
if (usage) {
  // muse-spark-1.3 Standard: $1.25 / 1M input, $0.15 / 1M cached input, $4.25 / 1M output.
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const cost = ((usage.prompt_tokens - cached) * 1.25 + cached * 0.15 + usage.completion_tokens * 4.25) / 1e6;
  console.error(
    `\n[${result.raw.model}] finish=${result.finishReason} in=${usage.prompt_tokens} (cached ${cached}) ` +
      `out=${usage.completion_tokens} (reasoning ${usage.completion_tokens_details?.reasoning_tokens ?? 0}) ~$${cost.toFixed(5)}`,
  );
}
