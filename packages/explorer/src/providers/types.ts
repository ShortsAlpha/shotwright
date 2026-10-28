/**
 * Provider-neutral conversation for the exploration loop. Each provider renders it in its own
 * wire format. Only the newest observation is sent in full (screenshot + element list); older
 * ones collapse to a one-line summary, which keeps the request small and the prefix cacheable.
 */
import type { ToolSpec } from "../tools.ts";

export interface ObservationPayload {
  readonly index: number;
  readonly text: string;
  readonly summary: string;
  /** JPEG/PNG bytes. */
  readonly image: Uint8Array;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  /** Set when the arguments were not valid JSON. */
  readonly argsError?: string;
}

export type HistoryItem =
  | { readonly kind: "user"; readonly text: string; readonly observation?: ObservationPayload }
  | { readonly kind: "assistant"; readonly text: string; readonly calls: readonly ToolCall[] }
  | {
      readonly kind: "results";
      readonly results: ReadonlyArray<{ readonly callId: string; readonly name: string; readonly output: string }>;
      readonly observation?: ObservationPayload;
    };

export interface Usage {
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
}

export function emptyUsage(): Usage {
  return { input: 0, cachedInput: 0, output: 0, reasoning: 0 };
}

export function addUsage(total: Usage, add: Usage): void {
  total.input += add.input;
  total.cachedInput += add.cachedInput;
  total.output += add.output;
  total.reasoning += add.reasoning;
}

export interface ProviderTurn {
  readonly text: string;
  readonly calls: readonly ToolCall[];
  readonly usage: Usage;
  readonly ms: number;
  /** Reasoning text when the provider returns it (Baseten's reasoning_content). */
  readonly reasoning?: string;
  readonly finish?: string;
}

export interface TurnRequest {
  readonly instructions: string;
  readonly tools: readonly ToolSpec[];
  readonly history: readonly HistoryItem[];
}

export interface ExplorerProvider {
  /** Short id for logs and file names, e.g. "spark-1.3". */
  readonly id: string;
  readonly model: string;
  /** "tools": native function calling. "json": the model answers with a JSON action in text. */
  readonly mode: "tools" | "json";
  next(request: TurnRequest): Promise<ProviderTurn>;
  /** What this usage costs us in USD (0 for free credits). */
  cost(usage: Usage): number;
  /** List price in USD, for comparisons. */
  listCost(usage: Usage): number;
}

/** Index of the newest history item that carries an observation (rendered in full). */
export function latestObservationIndex(history: readonly HistoryItem[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i]!;
    if (item.kind !== "assistant" && item.observation) return i;
  }
  return -1;
}
