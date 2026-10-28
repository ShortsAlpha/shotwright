/**
 * OpenAI-compatible Chat Completions provider, used for Muse Spark Open on Baseten.
 *
 * - "tools" mode: native function calling (Spark Open on Baseten supports it). Tool messages
 *   carry text only, so the newest screenshot goes in a user message after the tool results.
 * - "json" mode: for endpoints without tool support; the tools are described in the system
 *   prompt and the model answers with one JSON object per turn.
 */
import { MuseClient, dataUrl, type ChatContentPart, type ChatMessage, type ReasoningEffort } from "@shotwright/muse";
import { parseJsonAction, type ToolSpec } from "../tools.ts";
import { priceOf } from "./pricing.ts";
import { latestObservationIndex, type ExplorerProvider, type ProviderTurn, type ToolCall, type TurnRequest, type Usage } from "./types.ts";

export const BASETEN_BASE_URL = "https://inference.baseten.co/v1";
export const SPARK_OPEN_MODEL = "meta-models/muse-spark-open-1026";

export interface ChatProviderOptions {
  readonly model?: string;
  readonly client?: MuseClient;
  readonly mode?: "tools" | "json";
  readonly reasoningEffort?: ReasoningEffort;
  readonly maxTokens?: number;
  /** Credits are free (Baseten during the hackathon): cost() returns 0, listCost() the list price. */
  readonly free?: boolean;
  readonly id?: string;
}

export function basetenClient(apiKey = process.env.BASETEN_API_KEY): MuseClient {
  if (!apiKey) throw new Error("BASETEN_API_KEY is not set");
  return new MuseClient({ baseURL: BASETEN_BASE_URL, apiKey, timeoutMs: 180_000 });
}

export class ChatProvider implements ExplorerProvider {
  readonly id: string;
  readonly model: string;
  readonly mode: "tools" | "json";
  readonly #client: MuseClient;
  readonly #effort: ReasoningEffort | undefined;
  readonly #maxTokens: number;
  readonly #free: boolean;

  constructor(options: ChatProviderOptions = {}) {
    this.model = options.model ?? SPARK_OPEN_MODEL;
    this.mode = options.mode ?? "tools";
    this.id = options.id ?? (this.model === SPARK_OPEN_MODEL ? `spark-open${this.mode === "json" ? "-json" : ""}` : this.model);
    this.#client = options.client ?? basetenClient();
    this.#effort = options.reasoningEffort;
    this.#maxTokens = options.maxTokens ?? 6_000;
    this.#free = options.free ?? this.model === SPARK_OPEN_MODEL;
  }

  async next(request: TurnRequest): Promise<ProviderTurn> {
    const started = Date.now();
    const messages = this.mode === "tools" ? renderTools(request) : renderJson(request);
    const result = await this.#client.chat({
      model: this.model,
      messages,
      max_completion_tokens: this.#maxTokens,
      ...(this.#effort ? { reasoning_effort: this.#effort } : {}),
      ...(this.mode === "tools"
        ? {
            tools: request.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
            tool_choice: "auto" as const,
          }
        : {}),
    });
    const u = result.usage;
    const usage: Usage = {
      input: u?.prompt_tokens ?? 0,
      cachedInput: u?.prompt_tokens_details?.cached_tokens ?? 0,
      output: u?.completion_tokens ?? 0,
      reasoning: u?.completion_tokens_details?.reasoning_tokens ?? 0,
    };
    const reasoning = (result.message as { reasoning_content?: string }).reasoning_content ?? undefined;
    let calls: ToolCall[] = result.toolCalls.map((tc) => {
      try {
        const args = tc.function.arguments.trim() === "" ? {} : (JSON.parse(tc.function.arguments) as Record<string, unknown>);
        return { id: tc.id, name: tc.function.name, args };
      } catch {
        return { id: tc.id, name: tc.function.name, args: {}, argsError: `arguments were not valid JSON: ${tc.function.arguments.slice(0, 200)}` };
      }
    });
    if (this.mode === "json" && calls.length === 0) {
      const action = parseJsonAction(result.text);
      if (action) calls = [{ id: `json_${Date.now().toString(36)}`, name: action.name, args: action.args }];
    }
    return {
      text: result.text,
      calls,
      usage,
      ms: Date.now() - started,
      finish: result.finishReason,
      ...(reasoning ? { reasoning } : {}),
    };
  }

  cost(usage: Usage): number {
    return this.#free ? 0 : priceOf(this.model, usage);
  }

  listCost(usage: Usage): number {
    return priceOf(this.model, usage);
  }
}

function userContent(text: string, image?: Uint8Array): ChatContentPart[] {
  const parts: ChatContentPart[] = [{ type: "text", text }];
  if (image) parts.push({ type: "image_url", image_url: { url: dataUrl(image) } });
  return parts;
}

function renderTools(request: TurnRequest): ChatMessage[] {
  const latest = latestObservationIndex(request.history);
  const messages: ChatMessage[] = [{ role: "system", content: request.instructions }];
  request.history.forEach((item, index) => {
    const full = index === latest;
    switch (item.kind) {
      case "user":
        if (item.observation && full) messages.push({ role: "user", content: userContent(`${item.text}\n\n${item.observation.text}`, item.observation.image) });
        else messages.push({ role: "user", content: item.observation ? `${item.text}\n\n${item.observation.summary}` : item.text });
        break;
      case "assistant":
        messages.push(
          item.calls.length > 0
            ? {
                role: "assistant",
                content: item.text || null,
                tool_calls: item.calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })),
              }
            : { role: "assistant", content: item.text },
        );
        break;
      case "results":
        item.results.forEach((result, i) => {
          const last = i === item.results.length - 1;
          const extra = last && item.observation && !full ? `\n${item.observation.summary}` : "";
          messages.push({ role: "tool", tool_call_id: result.callId, content: result.output + extra });
        });
        if (item.observation && full) {
          messages.push({ role: "user", content: userContent(`Current screen after your action:\n${item.observation.text}`, item.observation.image) });
        }
        break;
    }
  });
  return messages;
}

function toolDocs(tools: readonly ToolSpec[]): string {
  return tools.map((t) => `- ${t.name}: ${t.description}\n  arguments (JSON schema): ${JSON.stringify(t.parameters)}`).join("\n");
}

function renderJson(request: TurnRequest): ChatMessage[] {
  const latest = latestObservationIndex(request.history);
  const system =
    `${request.instructions}\n\nYou cannot call functions directly. Each turn, answer with exactly one JSON object and nothing else:\n` +
    `{"tool": "<tool name>", "args": { ... }}\n` +
    `To mark a screen and act in the same turn, answer with {"tool": "mark_screen", ...} first; you will get another turn.\n\nTools:\n${toolDocs(request.tools)}`;
  const messages: ChatMessage[] = [{ role: "system", content: system }];
  request.history.forEach((item, index) => {
    const full = index === latest;
    switch (item.kind) {
      case "user":
        messages.push({
          role: "user",
          content: item.observation && full ? userContent(`${item.text}\n\n${item.observation.text}`, item.observation.image) : item.observation ? `${item.text}\n\n${item.observation.summary}` : item.text,
        });
        break;
      case "assistant":
        messages.push({
          role: "assistant",
          content: item.calls.length > 0 ? JSON.stringify(item.calls.length === 1 ? { tool: item.calls[0]!.name, args: item.calls[0]!.args } : item.calls.map((c) => ({ tool: c.name, args: c.args }))) : item.text,
        });
        break;
      case "results": {
        const text = item.results.map((r) => `${r.name}: ${r.output}`).join("\n");
        messages.push({
          role: "user",
          content: item.observation && full ? userContent(`${text}\n\n${item.observation.text}`, item.observation.image) : item.observation ? `${text}\n${item.observation.summary}` : text,
        });
        break;
      }
    }
  });
  return messages;
}
