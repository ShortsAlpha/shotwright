import { MODELS, type ReasoningEffort } from "@shotwright/muse";
import { ChatProvider, SPARK_OPEN_MODEL } from "./chat.ts";
import { MuseResponsesProvider } from "./muse-responses.ts";
import type { ExplorerProvider } from "./types.ts";

export * from "./types.ts";
export { PRICES, priceOf } from "./pricing.ts";
export { MuseResponsesProvider } from "./muse-responses.ts";
export { ChatProvider, BASETEN_BASE_URL, SPARK_OPEN_MODEL, basetenClient } from "./chat.ts";

/**
 * "spark" (muse-spark-1.3) and "wonder" (muse-wonder-1.0) on the Meta Model API's Responses
 * endpoint; "open" (Muse Spark Open on Baseten, native tools) and "open-json" (same model,
 * JSON actions in text).
 */
export function createProvider(name: string, options: { reasoningEffort?: ReasoningEffort } = {}): ExplorerProvider {
  const effort = options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {};
  switch (name) {
    case "spark":
    case MODELS.spark:
      return new MuseResponsesProvider({ model: MODELS.spark, ...effort });
    case "wonder":
    case MODELS.wonder:
      return new MuseResponsesProvider({ model: MODELS.wonder, ...effort });
    case "open":
    case SPARK_OPEN_MODEL:
      return new ChatProvider({ model: SPARK_OPEN_MODEL, mode: "tools", ...effort });
    case "open-json":
      return new ChatProvider({ model: SPARK_OPEN_MODEL, mode: "json", ...effort });
    default:
      throw new Error(`unknown provider ${name}; use spark, wonder, open or open-json`);
  }
}
