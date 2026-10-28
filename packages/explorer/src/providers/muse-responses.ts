/**
 * Muse Spark 1.3 / Muse Wonder 1.0 on the Meta Model API's Responses endpoint, with our own
 * function tools (docs/spikes/muse-api.md section 7.6), stateless (`store: false`): the full
 * conversation is sent every turn, with only the newest screenshot.
 */
import { MuseClient, dataUrl, type ResponseInputContent, type ResponseInputItem, type ReasoningEffort } from "@shotwright/muse";
import { priceOf } from "./pricing.ts";
import { latestObservationIndex, type ExplorerProvider, type ProviderTurn, type ToolCall, type TurnRequest, type Usage } from "./types.ts";

export interface MuseResponsesOptions {
  readonly model: string;
  readonly client?: MuseClient;
  readonly reasoningEffort?: ReasoningEffort;
  readonly maxOutputTokens?: number;
  readonly parallelToolCalls?: boolean;
  readonly id?: string;
  /** Default "shotwright-explore-v1". */
  readonly promptCacheKey?: string;
}

export class MuseResponsesProvider implements ExplorerProvider {
  readonly id: string;
  readonly model: string;
  readonly mode = "tools" as const;
  readonly #client: MuseClient;
  readonly #effort: ReasoningEffort | undefined;
  readonly #maxOutputTokens: number;
  readonly #parallel: boolean;
  readonly #cacheKey: string;

  constructor(options: MuseResponsesOptions) {
    this.model = options.model;
    this.id = options.id ?? options.model.replace(/^muse-/, "");
    this.#client = options.client ?? new MuseClient();
    this.#effort = options.reasoningEffort;
    this.#maxOutputTokens = options.maxOutputTokens ?? 6_000;
    this.#parallel = options.parallelToolCalls ?? true;
    this.#cacheKey = options.promptCacheKey ?? "shotwright-explore-v1";
  }

  async next(request: TurnRequest): Promise<ProviderTurn> {
    const input = render(request);
    const started = Date.now();
    const result = await this.#client.respond({
      model: this.model,
      instructions: request.instructions,
      tools: request.tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.parameters })),
      tool_choice: "auto",
      parallel_tool_calls: this.#parallel,
      store: false,
      max_output_tokens: this.#maxOutputTokens,
      prompt_cache_key: this.#cacheKey,
      ...(this.#effort ? { reasoning: { effort: this.#effort } } : {}),
      input,
    });
    const u = result.raw.usage;
    const usage: Usage = {
      input: u?.input_tokens ?? 0,
      cachedInput: u?.input_tokens_details?.cached_tokens ?? 0,
      output: u?.output_tokens ?? 0,
      reasoning: u?.output_tokens_details?.reasoning_tokens ?? 0,
    };
    const calls: ToolCall[] = result.functionCalls.map((fc) => {
      try {
        const parsed = fc.arguments.trim() === "" ? {} : (JSON.parse(fc.arguments) as Record<string, unknown>);
        return { id: fc.call_id, name: fc.name, args: parsed };
      } catch {
        return { id: fc.call_id, name: fc.name, args: {}, argsError: `arguments were not valid JSON: ${fc.arguments.slice(0, 200)}` };
      }
    });
    return { text: result.text, calls, usage, ms: Date.now() - started, finish: result.raw.status };
  }

  cost(usage: Usage): number {
    return priceOf(this.model, usage);
  }

  listCost(usage: Usage): number {
    return priceOf(this.model, usage);
  }
}

function render(request: TurnRequest): ResponseInputItem[] {
  const latest = latestObservationIndex(request.history);
  const items: ResponseInputItem[] = [];
  request.history.forEach((item, index) => {
    const full = index === latest;
    switch (item.kind) {
      case "user": {
        const content: ResponseInputContent[] = [];
        let text = item.text;
        if (item.observation) text += `\n\n${full ? item.observation.text : item.observation.summary}`;
        content.push({ type: "input_text", text });
        for (const extra of item.images ?? []) content.push({ type: "input_image", image_url: dataUrl(extra) });
        if (item.observation && full) content.push({ type: "input_image", image_url: dataUrl(item.observation.image) });
        items.push({ role: "user", content });
        break;
      }
      case "assistant":
        if (item.calls.length === 0) {
          if (item.text) items.push({ role: "assistant", content: [{ type: "output_text", text: item.text }] });
        } else {
          // Text next to a function call would need phase "commentary"; it is logged, not replayed.
          for (const call of item.calls) {
            items.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) });
          }
        }
        break;
      case "results":
        item.results.forEach((result, i) => {
          const last = i === item.results.length - 1;
          if (last && item.observation) {
            if (full) {
              items.push({
                type: "function_call_output",
                call_id: result.callId,
                output: [
                  { type: "input_text", text: `${result.output}\n\n${item.observation.text}` },
                  { type: "input_image", image_url: dataUrl(item.observation.image) },
                ],
              });
            } else {
              items.push({ type: "function_call_output", call_id: result.callId, output: `${result.output}\n${item.observation.summary}` });
            }
          } else {
            items.push({ type: "function_call_output", call_id: result.callId, output: result.output });
          }
        });
        break;
    }
  });
  return items;
}
