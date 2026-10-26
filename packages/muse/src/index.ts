/**
 * @shotwright/muse: a minimal, dependency-free client for the Meta Model API.
 *
 * Covers what Shotwright needs: Chat Completions (images as base64 PNG, tool
 * calling, structured output), the Responses API (needed for the native
 * `computer` tool and SAM 3.1), Muse Image generate/edit, SAM 3.1 segmentation
 * and Muse Voice Transcribe. Request bodies are passed through as typed objects.
 *
 * Server-side only: the API key must never reach a browser.
 * Facts, sources and open questions: docs/spikes/muse-api.md
 */

export const MUSE_BASE_URL = 'https://api.meta.ai/v1';

export const MODELS = {
  spark: 'muse-spark-1.3',
  sparkContributor: 'muse-spark-1.3-contributor',
  wonder: 'muse-wonder-1.0',
  image: 'muse-image-1.0',
  sam: 'sam-3.1',
  transcribe: 'muse-voice-transcribe-1.0',
} as const;

/** `"none"` is rejected by Muse Spark and Muse Wonder; `"max"` is not available on the contributor models. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type JsonSchema = { [key: string]: unknown };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MuseError extends Error {
  readonly status: number;
  readonly type: string | undefined;
  readonly code: string | undefined;
  readonly param: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    status: number,
    message: string,
    details: { type?: string; code?: string; param?: string; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'MuseError';
    this.status = status;
    this.type = details.type;
    this.code = details.code;
    this.param = details.param;
    this.retryAfterMs = details.retryAfterMs;
  }
}

// ---------------------------------------------------------------------------
// Chat Completions  (POST /v1/chat/completions)
// ---------------------------------------------------------------------------

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Images are accepted only in `user` messages; `developer` outranks `system`. */
export type ChatMessage =
  | { role: 'developer' | 'system'; content: string }
  | { role: 'user'; content: string | ChatContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatFunctionTool {
  type: 'function';
  function: { name: string; description?: string; parameters?: JsonSchema; strict?: boolean };
}

export interface JsonSchemaFormat {
  type: 'json_schema';
  json_schema: { name: string; schema: JsonSchema; description?: string; strict?: boolean };
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: ChatFunctionTool[];
  /** Only `"auto"` is supported; anything else returns HTTP 400. */
  tool_choice?: 'auto';
  parallel_tool_calls?: boolean;
  response_format?: JsonSchemaFormat | { type: 'json_object' } | { type: 'text' };
  reasoning_effort?: ReasoningEffort;
  max_completion_tokens?: number;
  prompt_cache_key?: string;
  prompt_cache_retention?: 'in_memory' | '24h';
  safety_identifier?: string;
  seed?: number;
  temperature?: number;
}

export interface ChatAssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ChatToolCall[];
  refusal?: string | null;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface ChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{ index: number; message: ChatAssistantMessage; finish_reason: string }>;
  usage?: ChatUsage;
}

export interface ChatResult {
  raw: ChatResponse;
  /** Append this to `messages` as-is before the `tool` results when continuing a tool loop. */
  message: ChatAssistantMessage;
  text: string;
  toolCalls: ChatToolCall[];
  /** `stop`, `length` or `tool_calls`. */
  finishReason: string;
  usage: ChatUsage | undefined;
}

// ---------------------------------------------------------------------------
// Responses API  (POST /v1/responses): computer use, SAM, reasoning replay
// ---------------------------------------------------------------------------

export type ResponseInputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url?: string; file_id?: string }
  | { type: 'input_video'; video_url?: string; file_id?: string }
  | { type: 'output_text'; text: string };

export interface ResponseMessageInput {
  type?: 'message';
  role: 'user' | 'developer' | 'system' | 'assistant';
  content: string | ResponseInputContent[];
  phase?: 'commentary' | 'final_answer';
}

/** `output` may be a string or content parts (text + a fresh screenshot), as Meta's macOS CUA recipe does. */
export interface FunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string | ResponseInputContent[];
}

/** Native computer-use actions. x/y are pixels in the last screenshot sent; (0,0) is top-left. */
export type ComputerAction =
  | { type: 'click'; button: 'left' | 'right' | 'wheel' | 'back' | 'forward'; x: number; y: number }
  | { type: 'double_click'; x: number; y: number }
  | { type: 'drag'; path: Array<{ x: number; y: number }> }
  | { type: 'keypress'; keys: string[] }
  | { type: 'move'; x: number; y: number }
  | { type: 'scroll'; x: number; y: number; scroll_x: number; scroll_y: number }
  | { type: 'type'; text: string }
  | { type: 'screenshot' }
  | { type: 'wait' };

export interface SafetyCheck {
  id: string;
  code?: string | null;
  message?: string | null;
}

export interface ComputerCall {
  type: 'computer_call';
  id: string;
  call_id: string;
  /** The guide shows a batched `actions` array; the schema also allows a single `action`. Use `computerActions()`. */
  action?: ComputerAction;
  actions?: ComputerAction[];
  pending_safety_checks: SafetyCheck[];
  /** Stateless replay only: copy unchanged into the next request's input. */
  meta_safety_replay_receipt?: string;
  status: 'in_progress' | 'completed' | 'incomplete';
}

export interface ComputerCallOutput {
  type: 'computer_call_output';
  call_id: string;
  acknowledged_safety_checks?: SafetyCheck[];
  output: { type: 'computer_screenshot'; image_url?: string; file_id?: string };
}

export interface ResponseOutputMessage {
  type: 'message';
  id: string;
  role: 'assistant';
  status: string;
  phase?: 'commentary';
  content: Array<{ type: 'output_text'; text: string; annotations?: unknown[] } | { type: 'refusal'; refusal: string }>;
}

export interface FunctionCall {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
  status?: string;
}

export interface ReasoningItem {
  type: 'reasoning';
  id?: string;
  summary: Array<{ type: 'summary_text'; text: string }>;
  encrypted_content?: string;
}

export interface ImageGenerationCall {
  type: 'image_generation_call';
  id: string;
  status: string;
  result: string | null;
}

export type ResponseOutputItem =
  | ResponseOutputMessage
  | FunctionCall
  | ComputerCall
  | ReasoningItem
  | ImageGenerationCall;

/** Output items can be replayed as input (stateless mode). */
export type ResponseInputItem = ResponseMessageInput | FunctionCallOutput | ComputerCallOutput | ResponseOutputItem;

export type ResponsesTool =
  | { type: 'function'; name: string; description?: string; parameters?: JsonSchema; strict?: boolean }
  | { type: 'computer' }
  | { type: 'web_search' };

export type TextFormat =
  | { type: 'json_schema'; name: string; schema: JsonSchema; description?: string; strict?: boolean }
  | { type: 'json_object' }
  | { type: 'text' };

export interface ResponsesRequest {
  model?: string;
  input: string | ResponseInputItem[];
  /** Not carried over by `previous_response_id`; resend every turn (same for `tools` and `reasoning`). */
  instructions?: string;
  tools?: ResponsesTool[];
  tool_choice?: 'auto';
  parallel_tool_calls?: boolean;
  /** Structured output on this endpoint is `text.format`; `response_format` returns HTTP 400. */
  text?: { format: TextFormat };
  reasoning?: { effort?: ReasoningEffort; summary?: 'auto' | 'concise' | 'detailed' };
  previous_response_id?: string;
  store?: boolean;
  /** e.g. `["reasoning.encrypted_content"]`; cannot be combined with `previous_response_id`. */
  include?: string[];
  max_output_tokens?: number;
  truncation?: 'auto' | 'disabled';
  prompt_cache_key?: string;
  prompt_cache_retention?: 'in_memory' | '24h';
  safety_identifier?: string;
  /** String values only (SAM uses `mask_encoding`, `include_confidence`, `propagation_direction`). */
  metadata?: Record<string, string>;
}

export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens: number };
  output_tokens_details?: { reasoning_tokens: number };
  images_processed?: number;
  video_frames_processed?: number;
}

export interface ResponsesResponse {
  id: string;
  object: 'response';
  status: 'completed' | 'failed' | 'in_progress' | 'cancelled' | 'queued' | 'incomplete';
  model: string;
  output: ResponseOutputItem[];
  incomplete_details?: { reason: string } | null;
  error?: { code: string; message: string } | null;
  usage?: ResponsesUsage;
}

export interface ResponsesResult {
  raw: ResponsesResponse;
  /** Concatenated `output_text` of all assistant messages. */
  text: string;
  functionCalls: FunctionCall[];
  computerCalls: ComputerCall[];
}

// ---------------------------------------------------------------------------
// Muse Image  (POST /v1/images/generations, /v1/images/edits)
// ---------------------------------------------------------------------------

export interface ImageGenerateRequest {
  model?: string;
  prompt: string;
  /** 1 to 10. */
  n?: number;
  /** "WxH"; sets the aspect ratio only, the generator picks the pixel size. */
  size?: string;
  output_format?: 'webp' | 'png' | 'jpeg';
  reasoning_strength?: 'high' | 'low';
  tool_enablement?: { enable_image_search?: boolean; enable_web_search?: boolean; enable_shell?: boolean };
  user?: string;
}

export interface ImageEditRequest extends ImageGenerateRequest {
  /** 1 to 10 images: bytes (sent as a data URL), a URL or data URL string, or an uploaded file. */
  images: Array<Uint8Array | string | { file_id: string }>;
}

export interface ImagesResponse {
  created: number;
  data: Array<{ b64_json?: string; url?: string }>;
  output_format?: string;
  background?: string;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
}

export interface ImagesResult {
  raw: ImagesResponse;
  /** Decoded `b64_json` images, in `output_format` (webp unless requested otherwise). */
  images: Uint8Array[];
}

// ---------------------------------------------------------------------------
// SAM 3.1  (POST /v1/responses with model sam-3.1)
// ---------------------------------------------------------------------------

export interface SegmentRequest {
  /** A short noun phrase ("tab bar"), or a box/point prompt built with `samPrompt()`. Never both. */
  prompt: string;
  /** PNG/JPEG bytes, or a URL / data URL. */
  image?: Uint8Array | string;
  /** MP4/MOV (H.264, H.265, MPEG-4) as a URL or data URL. */
  video?: string;
  /** A video uploaded with POST /v1/files (purpose user_data). */
  videoFileId?: string;
  maskEncoding?: 'lossless' | 'one_bit';
  includeConfidence?: boolean;
  /** Box/point prompts in video only. Default `both`. */
  propagationDirection?: 'both' | 'forward' | 'backward';
  model?: string;
}

/** Corners in source pixels, x2/y2 inclusive; w/h is the source media size. */
export interface SamBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  h: number;
  c?: number;
}

/** Undecoded mask. `payload` is base85 (alphabet undocumented); decode with `@meta-sam/parser` if needed. */
export interface SamMask {
  height: number;
  width: number;
  encoding: 'lossless' | 'one_bit';
  payload: string;
  c?: number;
}

export interface SamObject {
  /** Stable across frames within one response; not dense, not necessarily 0-based. */
  id: number;
  box: SamBox;
  mask: SamMask;
}

export interface SamFrame {
  frame: number;
  objects: SamObject[];
}

export interface SegmentResult {
  raw: ResponsesResponse;
  text: string;
  /** Empty when nothing matched (a valid outcome, not an error). Video frames may be sparse or out of order. */
  frames: SamFrame[];
}

export interface SamObjectPrompt {
  id: number;
  /** Source frame index; 0 for an image. */
  frame?: number;
  box?: { x1: number; y1: number; x2: number; y2: number };
  points?: Array<{ x: number; y: number; negative?: boolean }>;
}

// ---------------------------------------------------------------------------
// Muse Voice Transcribe  (POST /v1/asr/transcribe)
// ---------------------------------------------------------------------------

export interface TranscribeRequest {
  /** RIFF/WAVE, mono 16-bit PCM at 16 or 24 kHz, at most 10 minutes and 32 MB. */
  wav: Uint8Array | Blob;
  mode?: 'PUSH_TO_TALK' | 'ENDPOINTING' | 'DIARIZATION';
  keywords?: string[];
  /** Language names, e.g. ["English", "Turkish"]. */
  languageBias?: string[];
  model?: string;
}

export interface TranscribeResponse {
  sessionId: string;
  transcript: string;
  audioDurationMs: number;
  turns: Array<{ turnId: number; startMs: number; endMs: number; transcript: string; speaker?: string }>;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface MuseClientOptions {
  /** Defaults to MUSE_API_KEY, then MODEL_API_KEY (the name Meta's docs use). */
  apiKey?: string;
  /** Defaults to https://api.meta.ai/v1. Baseten (Muse Spark Open): https://inference.baseten.co/v1 */
  baseURL?: string;
  /** Retries for 429, 500, 503 and network errors, honoring Retry-After. Default 2. */
  maxRetries?: number;
  /** Per-attempt timeout. Default 300 s. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const RETRYABLE_STATUS = new Set([429, 500, 503]);
const MAX_RETRY_AFTER_MS = 60_000;

export class MuseClient {
  readonly baseURL: string;
  readonly #apiKey: string;
  readonly #maxRetries: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: MuseClientOptions = {}) {
    const env = globalThis.process?.env;
    const apiKey = options.apiKey ?? env?.MUSE_API_KEY ?? env?.MODEL_API_KEY;
    if (!apiKey) throw new Error('Muse API key missing: pass apiKey or set MUSE_API_KEY');
    this.#apiKey = apiKey;
    this.baseURL = (options.baseURL ?? MUSE_BASE_URL).replace(/\/+$/, '');
    this.#maxRetries = options.maxRetries ?? 2;
    this.#timeoutMs = options.timeoutMs ?? 300_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** Chat Completions. Defaults to muse-spark-1.3. */
  async chat(request: ChatRequest): Promise<ChatResult> {
    const raw = await this.post<ChatResponse>('/chat/completions', { ...request, model: request.model ?? MODELS.spark });
    const choice = raw.choices[0];
    if (!choice) throw new MuseError(200, 'chat completion returned no choices');
    return {
      raw,
      message: choice.message,
      text: choice.message.content ?? '',
      toolCalls: choice.message.tool_calls ?? [],
      finishReason: choice.finish_reason,
      usage: raw.usage,
    };
  }

  /** Responses API. Required for the native `computer` tool. Defaults to muse-spark-1.3. */
  async respond(request: ResponsesRequest): Promise<ResponsesResult> {
    const raw = await this.post<ResponsesResponse>('/responses', { ...request, model: request.model ?? MODELS.spark });
    if (raw.status === 'failed') {
      throw new MuseError(200, raw.error?.message ?? 'response failed', { code: raw.error?.code });
    }
    return summarizeResponse(raw);
  }

  async generateImage(request: ImageGenerateRequest): Promise<ImagesResult> {
    const raw = await this.post<ImagesResponse>('/images/generations', { ...request, model: request.model ?? MODELS.image });
    return { raw, images: decodeImages(raw) };
  }

  /** JSON-body edit (Meta extension): `images` as data URLs, URLs or file ids. */
  async editImage(request: ImageEditRequest): Promise<ImagesResult> {
    const images = request.images.map((image) =>
      typeof image === 'string'
        ? { image_url: image }
        : image instanceof Uint8Array
          ? { image_url: dataUrl(image) }
          : { file_id: image.file_id },
    );
    const raw = await this.post<ImagesResponse>('/images/edits', { ...request, model: request.model ?? MODELS.image, images });
    return { raw, images: decodeImages(raw) };
  }

  /** SAM 3.1, non-streaming. For long videos prefer streaming (non-streaming requests can hit HTTP 504). */
  async segment(request: SegmentRequest): Promise<SegmentResult> {
    const media: ResponseInputContent =
      request.image !== undefined
        ? { type: 'input_image', image_url: typeof request.image === 'string' ? request.image : dataUrl(request.image) }
        : request.videoFileId !== undefined
          ? { type: 'input_video', file_id: request.videoFileId }
          : request.video !== undefined
            ? { type: 'input_video', video_url: request.video }
            : fail('segment() needs image, video or videoFileId');

    const metadata: Record<string, string> = {};
    if (request.maskEncoding) metadata.mask_encoding = request.maskEncoding;
    if (request.includeConfidence) metadata.include_confidence = 'true';
    if (request.propagationDirection) metadata.propagation_direction = request.propagationDirection;

    const raw = await this.post<ResponsesResponse>('/responses', {
      model: request.model ?? MODELS.sam,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: request.prompt }, media] }],
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
    const { text } = summarizeResponse(raw);
    return { raw, text, frames: parseSamOutput(text) };
  }

  /** Transcribe one WAV recording (buffered JSON response). */
  async transcribe(request: TranscribeRequest): Promise<TranscribeResponse> {
    const settings = JSON.stringify({
      model: request.model ?? MODELS.transcribe,
      audioEncoding: 'WAV',
      mode: request.mode,
      keywords: request.keywords,
      languageBias: request.languageBias,
    });
    const boundary = `shotwright-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const audio = request.wav instanceof Blob ? request.wav : new Blob([Uint8Array.from(request.wav)]);
    const body = new Blob([
      `--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n${settings}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
      audio,
      `\r\n--${boundary}--\r\n`,
    ]);
    return this.send<TranscribeResponse>('/asr/transcribe', body, {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      Accept: 'application/json',
    });
  }

  /** Raw JSON POST for anything not wrapped above (e.g. `/responses/input_tokens`). */
  async post<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>(path, JSON.stringify(body), { 'Content-Type': 'application/json' });
  }

  async send<T>(path: string, body: string | Blob, headers: Record<string, string>): Promise<T> {
    const url = this.baseURL + path;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.#apiKey}`, ...headers },
          body,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
        if (attempt < this.#maxRetries && !timedOut) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw error;
      }
      if (response.ok) return (await response.json()) as T;
      const error = await toMuseError(response);
      if (attempt < this.#maxRetries && RETRYABLE_STATUS.has(response.status)) {
        await sleep(Math.min(error.retryAfterMs ?? backoffMs(attempt), MAX_RETRY_AFTER_MS));
        continue;
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

export function fromBase64(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/** Detects PNG, JPEG, WebP and GIF from magic bytes; falls back to PNG. */
export function imageMime(bytes: Uint8Array): string {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 3) === 'GIF') return 'image/gif';
  return 'image/png';
}

/** The declared MIME type must match the bytes (the computer tool returns HTTP 400 otherwise). */
export function dataUrl(bytes: Uint8Array, mime = imageMime(bytes)): string {
  return `data:${mime};base64,${toBase64(bytes)}`;
}

/** Chat Completions image part from bytes or a URL / data URL. */
export function imagePart(image: Uint8Array | string, detail?: 'auto' | 'low' | 'high'): ChatContentPart {
  const url = typeof image === 'string' ? image : dataUrl(image);
  return { type: 'image_url', image_url: detail ? { url, detail } : { url } };
}

/** A `user` chat message with text followed by images. */
export function userMessage(text: string, ...images: Array<Uint8Array | string>): ChatMessage {
  return { role: 'user', content: [{ type: 'text', text }, ...images.map((image) => imagePart(image))] };
}

/** Responses API image part from bytes or a URL / data URL. */
export function inputImage(image: Uint8Array | string): ResponseInputContent {
  return { type: 'input_image', image_url: typeof image === 'string' ? image : dataUrl(image) };
}

/** `response_format` for Chat Completions. Use `{ type: 'json_schema', name, schema }` as `text.format` on Responses. */
export function jsonSchemaFormat(name: string, schema: JsonSchema, strict?: boolean): JsonSchemaFormat {
  return { type: 'json_schema', json_schema: strict === undefined ? { name, schema } : { name, schema, strict } };
}

/** Actions of a computer call, whether batched (`actions`) or single (`action`). */
export function computerActions(call: ComputerCall): ComputerAction[] {
  return call.actions ?? (call.action ? [call.action] : []);
}

/** The `computer_call_output` that answers `call` with a fresh screenshot. Only pass checks you actually reviewed. */
export function computerScreenshot(
  call: Pick<ComputerCall, 'call_id'>,
  screenshot: Uint8Array | string,
  acknowledged: SafetyCheck[] = [],
): ComputerCallOutput {
  return {
    type: 'computer_call_output',
    call_id: call.call_id,
    acknowledged_safety_checks: acknowledged,
    output: {
      type: 'computer_screenshot',
      image_url: typeof screenshot === 'string' ? screenshot : dataUrl(screenshot),
    },
  };
}

/** Builds a SAM box/point prompt, e.g. from an accessibility frame converted to screenshot pixels. */
export function samPrompt(media: { w: number; h: number }, objects: SamObjectPrompt[]): string {
  const size = `w=${Math.round(media.w)};h=${Math.round(media.h)}`;
  const px = (value: number, max: number) => Math.min(Math.max(Math.floor(value), 0), max - 1);
  const byFrame = new Map<number, string[]>();
  for (const object of objects) {
    let tokens = '';
    if (object.box) {
      const { x1, y1, x2, y2 } = object.box;
      tokens += `<|box;x1=${px(x1, media.w)};y1=${px(y1, media.h)};x2=${px(x2, media.w)};y2=${px(y2, media.h)};${size}|>`;
    }
    for (const point of object.points ?? []) {
      tokens += `${point.negative ? '-' : ''}<|point;x=${px(point.x, media.w)};y=${px(point.y, media.h)};${size}|>`;
    }
    const frame = object.frame ?? 0;
    byFrame.set(frame, [...(byFrame.get(frame) ?? []), `${object.id}${tokens}`]);
  }
  return [...byFrame.entries()]
    .sort(([a], [b]) => a - b)
    .map(([frame, records]) => `<${frame}f>${records.join(',')}`)
    .join('');
}

const SAM_FRAME = /(?:^|(?<=\|>)|(?<=\s))<(\d+)f>/g;
const SAM_RECORD = /(\d+)<\|box;([^|]*)\|><\|mask;(.*?)\|>(?=,\d+<\|box;|<\d+f>|\s|$)/gs;

/** Parses SAM's special-token output (https://dev.meta.ai/docs/sam/reading-segmentation). Masks stay encoded. */
export function parseSamOutput(text: string): SamFrame[] {
  const markers = [...text.matchAll(SAM_FRAME)];
  return markers.map((marker, index) => {
    const start = (marker.index ?? 0) + marker[0].length;
    const end = markers[index + 1]?.index ?? text.length;
    const objects: SamObject[] = [];
    for (const [, id, boxFields, maskFields] of text.slice(start, end).matchAll(SAM_RECORD)) {
      const box = fields(boxFields ?? '');
      const dataAt = (maskFields ?? '').indexOf('data=');
      const mask = fields((maskFields ?? '').slice(0, Math.max(dataAt, 0)));
      const data = /^(\d+),(\d+),([~!])/.exec((maskFields ?? '').slice(dataAt + 5));
      if (dataAt < 0 || !data) continue;
      objects.push({
        id: Number(id),
        box: { x1: box.x1 ?? 0, y1: box.y1 ?? 0, x2: box.x2 ?? 0, y2: box.y2 ?? 0, w: box.w ?? 0, h: box.h ?? 0, ...(box.c === undefined ? {} : { c: box.c }) },
        mask: {
          height: Number(data[1]),
          width: Number(data[2]),
          encoding: data[3] === '!' ? 'one_bit' : 'lossless',
          payload: (maskFields ?? '').slice(dataAt + 5 + data[0].length),
          ...(mask.c === undefined ? {} : { c: mask.c }),
        },
      });
    }
    return { frame: Number(marker[1]), objects };
  });
}

function fields(source: string): Record<string, number | undefined> {
  const result: Record<string, number | undefined> = {};
  for (const pair of source.split(';')) {
    const [key, value] = pair.split('=');
    if (key && value !== undefined) result[key] = Number(value);
  }
  return result;
}

function summarizeResponse(raw: ResponsesResponse): ResponsesResult {
  let text = '';
  const functionCalls: FunctionCall[] = [];
  const computerCalls: ComputerCall[] = [];
  for (const item of raw.output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content) if (part.type === 'output_text') text += part.text;
    } else if (item.type === 'function_call') {
      functionCalls.push(item);
    } else if (item.type === 'computer_call') {
      computerCalls.push(item);
    }
  }
  return { raw, text, functionCalls, computerCalls };
}

function decodeImages(raw: ImagesResponse): Uint8Array[] {
  return raw.data.flatMap((image) => (image.b64_json ? [fromBase64(image.b64_json)] : []));
}

async function toMuseError(response: Response): Promise<MuseError> {
  const retryAfter = Number(response.headers.get('retry-after'));
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
  const body = await response.text().catch(() => '');
  let error: { message?: string; type?: string; code?: string | null; param?: string | null } = {};
  try {
    const parsed = JSON.parse(body) as { error?: typeof error };
    error = parsed.error ?? {};
  } catch {
    // Unknown paths return 404 with an empty body; some endpoints return plain text.
  }
  return new MuseError(response.status, error.message ?? (body || `HTTP ${response.status}`), {
    ...(error.type ? { type: error.type } : {}),
    ...(error.code ? { code: error.code } : {}),
    ...(error.param ? { param: error.param } : {}),
    ...(retryAfterMs ? { retryAfterMs } : {}),
  });
}

function backoffMs(attempt: number): number {
  return 500 * 2 ** attempt + Math.random() * 250;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message: string): never {
  throw new Error(message);
}
