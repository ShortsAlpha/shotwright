/** USD per 1M tokens (Standard mode). Sources: docs/spikes/muse-api.md section 1 and 12. */
import type { Usage } from "./types.ts";

export interface Price {
  readonly input: number;
  readonly cached: number;
  readonly output: number;
}

export const PRICES: Readonly<Record<string, Price>> = {
  "muse-spark-1.3": { input: 1.25, cached: 0.15, output: 4.25 },
  "muse-wonder-1.0": { input: 4.0, cached: 0.2, output: 20.0 },
  // Baseten's list price equals Spark 1.3; hackathon credits make it free for us.
  "meta-models/muse-spark-open-1026": { input: 1.25, cached: 0.15, output: 4.25 },
};

/** Output tokens include reasoning tokens (both APIs report reasoning as a subset of output). */
export function priceOf(model: string, usage: Usage): number {
  const price = PRICES[model];
  if (!price) return 0;
  const uncached = Math.max(usage.input - usage.cachedInput, 0);
  return (uncached * price.input + usage.cachedInput * price.cached + usage.output * price.output) / 1e6;
}
