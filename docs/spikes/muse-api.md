# Spike: Meta Model API (Muse)

Date: 2026-10-26. Status: docs and cookbook read; **no API call made** (no key yet). Client: `packages/muse` (see [section 13](#13-the-client-packagesmuse)).

How to read this: every fact cites its source page. Items marked **UNVERIFIED** are inferred, conflicting, or missing from the docs and should be checked with the first real calls. Every docs page also has a Markdown twin at `<page>.md` (for example `https://dev.meta.ai/docs/computer-use.md`), and `https://dev.meta.ai/llms.txt` indexes all of them. That is how this spike read the docs; WebFetch summaries drop detail.

## TL;DR

- **Base URL** `https://api.meta.ai/v1`, header `Authorization: Bearer <key>`. OpenAI-compatible Chat Completions and Responses; Anthropic-compatible Messages at base `https://api.meta.ai`. Meta's docs call the key variable `MODEL_API_KEY`; we use `MUSE_API_KEY` (the client accepts both).
- **Computer use** is a native tool, `{"type": "computer"}`, on the **Responses API only**. It works on `muse-wonder-1.0` and `muse-spark-1.3`. The model returns a `computer_call` with a batch of `actions` (`click`, `double_click`, `drag`, `keypress`, `move`, `scroll`, `type`, `screenshot`, `wait`). Coordinates are **pixels in the last screenshot we sent**. We answer with a `computer_call_output` whose `output` is `{"type": "computer_screenshot", "image_url": "data:image/png;base64,..."}`. The tool has no slot for an accessibility tree.
- Plain vision grounding on Muse Spark uses a different convention: a **normalized 0–1000 grid**. Meta's own macOS agent recipe uses function tools with 0–1000 coordinates instead of the native tool.
- **Recommendation for Shotwright:** drive the Simulator with our own function tools keyed on accessibility-tree element ids, plus a 0–1000 coordinate fallback, on the Responses API. Each `function_call_output` returns the new screenshot and tree. This records steps as accessibility ids directly (PLAN step 3). Keep the native `computer` tool as a Wonder-only fallback ([section 7.6](#76-what-this-means-for-the-ios-simulator)).
- `tool_choice` only accepts `"auto"`. Structured output is `response_format` on Chat Completions and `text.format` on Responses; sending one endpoint's parameter to the other returns `HTTP 400`.
- **Muse Image** returns its own fixed resolution (`size` only sets the aspect ratio) and WebP by default. We will upscale or crop for App Store sizes.
- **SAM 3.1** goes through `POST /v1/responses` with `model: "sam-3.1"`. It returns special-token text (boxes plus base85 masks) and accepts box and point prompts, so we can seed tracking with the accessibility frame of the element we tapped.
- **Baseten model id:** Meta's docs and Baseten's page say `meta-models/muse-spark-open`, but the hackathon participant guide says: "For the hackathon, use meta-models/muse-spark-open-1026 instead." Use the `-1026` id. Baseten's listed price equals Muse Spark 1.3 Standard, so it only helps if the Baseten credits are granted ([section 12](#12-muse-spark-open-on-baseten)).

---

## 1. Base URL, auth, protocols

| Fact | Value | Source |
|---|---|---|
| Base URL | `https://api.meta.ai/v1` | https://dev.meta.ai/docs/overview |
| Auth | `Authorization: Bearer $MODEL_API_KEY`, plus `Content-Type: application/json` on JSON bodies | https://dev.meta.ai/docs/authentication |
| Key format | `LLM_<numeric id>_<secret>` per the auth page; the cookbook says `LLM\|{numeric_id}\|{secret}`. **UNVERIFIED** which is current; we treat the key as opaque. | https://dev.meta.ai/docs/authentication, https://github.com/meta-models/meta-model-cookbook/blob/main/01_api_fundamentals/README.md |
| SDKs | OpenAI SDK, Anthropic SDK and OpenAI-compatible clients. None reads `MODEL_API_KEY` itself. The cookbook says the "official Model API client package is out of date — do not use it". | https://dev.meta.ai/docs/authentication, cookbook README above |
| Protocols | `POST /v1/chat/completions` (stateless), `POST /v1/responses` (stateful or stateless; required for computer use, SAM, web search and reasoning replay), `POST /v1/messages` (Anthropic shape, base URL `https://api.meta.ai`, always stateless) | https://dev.meta.ai/docs/protocols/responses, https://dev.meta.ai/docs/protocols/messages |
| Other endpoints | `POST /v1/images/generations`, `POST /v1/images/edits`, `POST /v1/asr/transcribe`, `wss://api.meta.ai/v1/asr/realtime`, `POST /v1/files`, `GET /v1/models`, `POST /v1/responses/input_tokens`, `POST /v1/messages/count_tokens` | https://dev.meta.ai/docs/overview, https://dev.meta.ai/docs/token-counting |
| Keys are team-scoped | Rate limits are per team, not per key | https://dev.meta.ai/docs/pricing-rate-limits |

Models and prices (Standard mode, per 1M tokens) from https://dev.meta.ai/docs/pricing-rate-limits:

| Model | Input | Cached input | Output | Notes |
|---|---|---|---|---|
| `muse-wonder-1.0` | $4.00 | $0.20 | $20.00 | Preview; 1,048,576-token context; no Contributor mode on pay-as-you-go; not available in South Korea (https://dev.meta.ai/docs/models) |
| `muse-spark-1.3` | $1.25 | $0.15 | $4.25 | 1,048,576 context; audio input on 1.3 is "not fully supported" (https://dev.meta.ai/docs/models) |
| `muse-spark-1.3-contributor` | $0.10 | $0.002 | $0.20 | Content may be used to train Meta models; no `"max"` effort |
| `muse-image-1.0` | $0.01 per image | | | |
| `sam-3.1` | $2.50 per 1,000 images; $0.20 per 1,000 video frames (minimum 50 frames per video request) | | | |
| `muse-voice-transcribe-1.0` | $0.18 per hour of audio, metered in whole seconds | | | |

Web search grounding costs an extra $2.50 per 1,000 queries (https://dev.meta.ai/docs/pricing-rate-limits). Meta-injected steering tokens are not billed (same page).

## 2. Chat with image input

**Chat Completions** (https://dev.meta.ai/docs/image-understanding, cookbook `01_api_fundamentals/07_vision_input.ipynb`):

```json
{
  "model": "muse-spark-1.3",
  "messages": [
    {"role": "developer", "content": "You describe iOS screens."},
    {"role": "user", "content": [
      {"type": "text", "text": "Describe this screen."},
      {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0..."}}
    ]}
  ]
}
```

- The answer is in `choices[0].message.content`. `finish_reason` is `stop`, `length` or `tool_calls`. Usage fields: `usage.prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens` and `completion_tokens_details.reasoning_tokens` (https://dev.meta.ai/docs/protocols/chat-completions).
- `image_url.detail` accepts `auto` (default), `low` or `high` (https://dev.meta.ai/docs/api-reference/chat-completions/schemas). **UNVERIFIED** whether it changes token cost.
- **Responses** wraps images differently: `{"type": "input_image", "image_url": "<url or data URL>"}`, where `image_url` is a plain string, or `{"type": "input_image", "file_id": "file-..."}`. Text goes in `{"type": "input_text", "text": ...}` (https://dev.meta.ai/docs/image-understanding).
- Images are accepted only in `user` messages. An image in a `developer` or `system` message returns `HTTP 400` (cookbook 07; https://dev.meta.ai/docs/image-understanding).
- Limits: **50 images per request** (enforced, `HTTP 400` above that), 50 MB per inline image, 1 GiB via the Files API. MIME types: `image/jpeg`, `image/jpg`, `image/png`, `image/gif`, `image/webp`, `image/x-icon` (https://dev.meta.ai/docs/image-understanding).
- Image token cost scales with resolution: a 1x1 image is about 3 tokens and a ~1280 px image about 1,300–1,500 tokens. Measure with `POST /v1/responses/input_tokens` (https://dev.meta.ai/docs/image-understanding, https://dev.meta.ai/docs/token-counting).
- Roles: `developer` is the highest-precedence role we can set. `system` is accepted but merged at the same level, so prefer `developer` (https://dev.meta.ai/docs/protocols/chat-completions).
- Sampling: Muse Spark is tuned for the defaults `temperature: 1.0` and `top_p: 1.0`, so leave them unset (same page).
- Rejected with `HTTP 400` on Chat Completions: `stop`, `n > 1`, `logit_bias`, `logprobs: true`, `prediction`, `verbosity`, `modalities`, `audio`, `web_search_options` and `max_output_tokens`. Use `max_completion_tokens` instead of the last (same page).
- Non-streaming requests have a server-side time limit and return `HTTP 504 gateway_timeout`. Use streaming or `background: true` for long jobs (https://dev.meta.ai/docs/error-handling).

## 3. Tool calling

Source: https://dev.meta.ai/docs/tool-calling unless noted.

- **Chat Completions** nests the definition: `{"type": "function", "function": {"name", "description", "parameters", "strict"?}}`. The reply has `finish_reason: "tool_calls"` and `message.tool_calls[] = {id, type: "function", function: {name, arguments: "<JSON string>"}}`. Append the **whole assistant message**, then one `{"role": "tool", "tool_call_id", "content"}` per call. Omitting the assistant message returns `HTTP 400`.
- **Responses** uses a flat definition: `{"type": "function", "name", "description", "parameters", "strict"?}`. The output contains `{"type": "function_call", "call_id", "name", "arguments", "status"}` items. Answer with `{"type": "function_call_output", "call_id", "output"}`. `output` may be a string or content parts; Meta's macOS agent returns `[{"type": "input_text"}, {"type": "input_image", "image_url": "data:..."}]` to hand back a screenshot (cookbook `03_use_cases/13_macos_cua/python/metacua/muse_spark.py`).
- **`tool_choice` must be `"auto"`.** `"none"`, `"required"` and named choices return `HTTP 400` on Chat Completions and Responses. The Messages API maps `any` and `none`.
- `parallel_tool_calls` defaults to `true`. Set `false` for serial UI actions.
- Function names must match `^[a-zA-Z0-9_.-]+$` with **at most one dot**. `call_id` must be 1–64 characters.
- `strict` defaults to `false`. Even with `strict: true`, generated arguments are "not guaranteed to validate", so validate them yourself.
- `custom` tools take free-form text and are Responses-only.
- Built-in tools: `web_search` and `tool_search` (Responses).
- Conversation structure is validated strictly (https://dev.meta.ai/docs/protocols/responses):
  - Every replayed `reasoning` item must be followed by an assistant message or `function_call` before the next user, system or developer message.
  - Intermediate assistant text before a `function_call` must carry `phase: "commentary"`.
  - Without `previous_response_id`, every `function_call_output.call_id` must match a `function_call` in the same request.

## 4. Structured output (JSON schema)

Source: https://dev.meta.ai/docs/structured-output.

| Endpoint | Field |
|---|---|
| Chat Completions | `response_format: {"type": "json_schema", "json_schema": {"name", "schema", "strict"?, "description"?}}` (also `{"type": "json_object"}`) |
| Responses | `text: {"format": {"type": "json_schema", "name", "schema", "strict"?, "description"?}}`. `name` is `[a-zA-Z0-9_-]`, at most 64 characters (https://dev.meta.ai/docs/api-reference/responses/schemas) |
| Messages | `output_config.format: {"type": "json_schema", "schema"}` (https://dev.meta.ai/docs/protocols/messages) |

- Decoding is constrained, so output always conforms. `strict: false` behaves the same for output; `strict: true` only adds validation of the schema against OpenAI's strict subset (root object, `additionalProperties: false` everywhere, every property in `required`, no `allOf` or `oneOf`).
- Schema limits: nesting depth 10, 5,000 properties, 120,000 total string characters, 1,000 enum values, and 200,000 nodes after inlining `$ref`. **Recursive schemas return `HTTP 400`.**
- Sending `text.format` to Chat Completions, or `response_format` to Responses, returns `HTTP 400` (https://dev.meta.ai/docs/protocols/chat-completions; cookbook 04).

## 5. Reasoning effort

Source: https://dev.meta.ai/docs/reasoning.

- Chat Completions takes top-level `reasoning_effort`. Responses takes `reasoning: {"effort": ...}`. Messages takes `thinking: {"type": "adaptive"}` plus `output_config.effort`.
- Values: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
  - `"none"` returns `HTTP 400` on Spark and Wonder.
  - `"max"` works only on `muse-wonder-1.0` and `muse-spark-1.3`, not the contributor model.
  - When omitted, the model reasons at a model-chosen level.
- **Conflict:** cookbook 06 says `xhigh` "maps to the same reasoning strength as `high`". The reasoning page lists it as deeper. **UNVERIFIED.**
- Reasoning tokens are billed as output. They appear in `completion_tokens_details.reasoning_tokens` (Chat) and `output_tokens_details.reasoning_tokens` (Responses). They also count against `max_completion_tokens` / `max_output_tokens`, so set those generously; the video guide recommends at least 4,000 (https://dev.meta.ai/docs/video-understanding).
- Chain of thought is never returned as text. Chat Completions' `reasoning_content` is redacted to empty, so Chat **cannot** carry reasoning across turns.
- Responses carries it in two ways:
  - `previous_response_id` (server state).
  - `store: false` plus `include: ["reasoning.encrypted_content"]`, then replaying `{"type": "reasoning", "summary": [], "encrypted_content"}` items. This option cannot be combined with `previous_response_id` (`HTTP 400`).
- Optional summaries: `reasoning.summary`: `auto`, `concise` or `detailed`.
- Meta's macOS agent drops `reasoning` items when replaying with `store: false`, because echoing them caused a "persistence service error" (cookbook `metacua/muse_spark.py`). **UNVERIFIED** whether that still happens.

## 6. Prompt caching

Source: https://dev.meta.ai/docs/prompt-caching.

- **Automatic prefix caching.** There is no flag and no breakpoint to set. Put stable content (instructions, tool definitions, few-shot examples) first and volatile content last.
- Optional `prompt_cache_key`: a stable string per shared prefix (for example `"shotwright-explore-v1"`), not per user. It routes requests to the same backend.
- Optional `prompt_cache_retention`: `"in_memory"` (default) or `"24h"`. This is a hint, not a guarantee.
- Read hits from `usage.prompt_tokens_details.cached_tokens` (Chat) or `usage.input_tokens_details.cached_tokens` (Responses). Cached tokens are a subset of input, billed at the cached rate.
- Caching is independent of `store`.
- With `previous_response_id`, usage "reports only the new turn's `input_tokens` and `cached_tokens`, not the full reconstructed prefix". **UNVERIFIED** whether *billing* also counts only the new turn. If it does, server-side state is much cheaper for long screenshot loops. Check the console after the first exploration run.
- The Messages page never mentions Anthropic `cache_control`. **UNVERIFIED** whether it is accepted or ignored; unknown top-level Messages fields are rejected (https://dev.meta.ai/docs/protocols/messages).

## 7. Computer use (most important for Shotwright)

Source: https://dev.meta.ai/docs/computer-use and the schema at https://dev.meta.ai/docs/api-reference/responses/schemas, unless noted.

### 7.1 Enabling it

- Add `"tools": [{"type": "computer"}]` to a **Responses API** request; that is the tool's "only supported endpoint". The tool has no display-size or environment fields.
- The guide's loop uses `muse-wonder-1.0` and says Muse Spark "runs the same loop at lower cost: set both `model` values to `muse-spark-1.3`".
- There is no server-side VM. Meta returns actions; we execute them and send back screenshots.
- Put rules in `instructions` and resend them every turn; `instructions`, `tools` and `reasoning` do not persist across `previous_response_id` (https://dev.meta.ai/docs/protocols/responses).

### 7.2 What the model returns

```json
{
  "type": "computer_call",
  "id": "cc_abc123",
  "call_id": "call_abc123",
  "actions": [
    {"type": "click", "button": "left", "x": 412, "y": 315},
    {"type": "type", "text": "quarterly revenue"},
    {"type": "keypress", "keys": ["Enter"]}
  ],
  "pending_safety_checks": [],
  "status": "completed"
}
```

The schema allows either `actions` (an array) or a single `action`; both are optional. Handle both; the client's `computerActions()` does.

| `type` | Fields | Meaning |
|---|---|---|
| `click` | `button` (`left`, `right`, `wheel`, `back`, `forward`), `x`, `y` | single click |
| `double_click` | `x`, `y` | double click |
| `drag` | `path: [{x, y}, ...]` | press, move through the path, release |
| `keypress` | `keys: string[]` | key or combination |
| `move` | `x`, `y` | move the cursor |
| `scroll` | `x`, `y`, `scroll_x`, `scroll_y` | scroll at a point by the given deltas (units and sign **UNVERIFIED**) |
| `type` | `text` | type literal text |
| `screenshot` | — | capture only |
| `wait` | — | wait for the UI to settle |

**Coordinate system:** "pixel coordinates in the space of the screenshot you last sent: `(0, 0)` is the top-left, and the maximum is the width and height of that image". The guide also says "keep the screenshot size stable across a trajectory". The model sees the image we send, so if we downscale, coordinates come back in downscaled pixels.

Batching: run the actions in order, take **one** screenshot afterwards, and stop early if the screen changes unexpectedly.

### 7.3 What we send back

```json
{
  "type": "computer_call_output",
  "call_id": "call_abc123",
  "acknowledged_safety_checks": [],
  "output": {"type": "computer_screenshot", "image_url": "data:image/png;base64,<...>"}
}
```

- `image_url` must be a base64 PNG or JPEG data URL whose declared MIME type matches the bytes. The decoded image must be 25 MiB or smaller, otherwise `HTTP 400`.
- The schema also allows `output.file_id` instead of `image_url`, and `output.detail: "original"`.
- Return a screenshot every turn; only a `screenshot`-only or `wait`-only call needs no earlier image.
- First turn: a user message with `input_text` (the task) and `input_image` (the initial screenshot).

### 7.4 Safety checks

- A `computer_call` may carry `pending_safety_checks: [{id, code, message}]`, for example `code: "malicious_instructions"`.
- To proceed, echo the checks in `acknowledged_safety_checks` on the matching output. Acknowledging "asserts that you reviewed the action and accepts it", so treat it as a decision point and do not auto-fill it.
- For Shotwright: on a pending check, stop the run and surface it to the developer, or skip that path. Never blindly acknowledge, because developers' apps may contain arbitrary on-screen text (prompt injection).

### 7.5 State, history and limits

- **Server state:** `previous_response_id`, with `store: true` as the default. Send only the new `computer_call_output` each turn.
- **Stateless:** `store: false`, replaying every `computer_call` / `computer_call_output` pair. Copy each `meta_safety_replay_receipt` unchanged into the replayed item. "Direct stateless replay holds up to 29 call/output pairs."
- `truncation: "auto"` (keep recent screenshots, trim older ones) is available "where it's enabled for your account", and returns `HTTP 400` otherwise (https://dev.meta.ai/docs/computer-use). **Conflict:** https://dev.meta.ai/docs/protocols/responses says `truncation: "auto"` is always rejected and you must compact history yourself. Assume it is unavailable.
- The 50-images-per-request cap is enforced (https://dev.meta.ai/docs/image-understanding). **UNVERIFIED** whether screenshots held in server state via `previous_response_id` count toward it. In stateless mode they certainly do. Meta's macOS agent keeps only the last 5 screenshots by default and replaces older ones with the text `[Screenshot has been truncated to save context]` (cookbook `13_macos_cua/python/README.md`).
- **Done:** the model stops emitting `computer_call` and returns a normal assistant message. Meta's system prompt (on the guide page) tells it to finish only when the goal is visibly complete, or to explain why the task is infeasible.
- **Incomplete:** a run that hits `max_output_tokens` returns `HTTP 200` with `status: "incomplete"` and `incomplete_details.reason: "max_output_tokens"`.
- **Payload size:** with `store: true`, large inline base64 can return `HTTP 413 payload_too_large` (~16 MB serialized), and background requests are capped at 1 MiB (https://dev.meta.ai/docs/error-handling). Downscaled screenshots avoid both.
- **Privacy:** `store: true` keeps developers' screenshots on Meta's side. `store: false` with stateless replay avoids that, at the cost of the 29-pair limit.

### 7.6 What this means for the iOS Simulator

The native tool speaks desktop mouse and keyboard. We would map its actions to touch:

| Native action | Simulator action |
|---|---|
| `click` (left) | tap |
| `double_click` | double tap |
| `click` (right) | long press (our convention) |
| `drag` | swipe along `path` |
| `scroll` | swipe opposite to the content direction (sign **UNVERIFIED**; test it) |
| `type` | text input |
| `keypress` `Enter` | return |
| `move` | no-op |
| `wait` | sleep about 1 s, then screenshot |

Two ways to drive the Simulator:

1. **Native `computer` tool.**
   - Send screenshots **downscaled to the device's point size** (for example 1320×2868 px becomes 440×956 at 3x). Returned pixels are then Simulator points, ready for tap commands, and each screenshot costs fewer tokens.
   - Downside: there is no place for the accessibility tree in a `computer_call_output`. We could add a `user` message carrying the tree next to each output, but **UNVERIFIED** whether the structure validator accepts that.
   - Steps come back as coordinates, but PLAN step 3 wants accessibility-id steps, so we would need to reverse-map taps to elements.
2. **Our own function tools (recommended).** This mirrors Meta's macOS agent, which uses function tools `computer.computer` and `computer.stop` with normalized 0–1000 coordinates on `POST /v1/responses`, `parallel_tool_calls: false` and `store: false` (cookbook `13_macos_cua/python/README.md`).
   - Proposed tools:
     - `tap(element_id)`, `tap_at(x, y)` in 0–1000 (the grid Muse Spark uses for grounding, https://dev.meta.ai/docs/image-understanding)
     - `swipe(direction | from, to)`
     - `type_text(text)`, `press(button)`
     - `wait(seconds)`
     - `done(screens_ranked, notes)`
   - Each `function_call_output.output` returns `[input_text (compact accessibility tree with ids), input_image (screenshot)]`.
   - Advantages:
     - Steps are recorded as accessibility ids directly.
     - It works on Spark at Spark prices.
     - The tool set is deterministic, so prompt caching works.
     - `done` can use a JSON schema.
   - Handle plain-text replies, since `tool_choice` is `"auto"` only.

Spark versus Wonder costs 3.2x more for input and 4.7x more for output on Wonder (section 1); the request shape is identical, so it is just a model id switch (https://dev.meta.ai/docs/models).

**Cost sketch (UNVERIFIED, measure with `/v1/responses/input_tokens`):**

- Assume a downscaled screenshot plus tree is about 1.5k input tokens and the model uses about 0.5k output tokens per step.
- A 40-step exploration on Spark resending the last 5 screenshots: about 40 × 7.5k = 300k input (largely cacheable) plus 20k output, roughly **$0.10–0.45**. Wonder costs about 4x that.
- This fits PLAN's $3–6 per run estimate with room to spare.

## 8. Image generation and editing (Muse Image)

Source: https://dev.meta.ai/docs/image-generation and https://dev.meta.ai/docs/api-reference/images/schemas.

- `POST /v1/images/generations` takes JSON:
  - required: `model`, `prompt`
  - optional: `n` (1–10), `size` (`"WxH"`, **aspect ratio only**), `response_format` (`b64_json` default, or `url` for a temporary signed URL), `output_format` (`webp` default, `png`, `jpeg`), `reasoning_strength` (`high` default, or `low` for a single pass), `tool_enablement: {enable_image_search, enable_web_search, enable_shell}` (all on by default), `user`, `stream`
- `POST /v1/images/edits` takes the same fields plus `images: [{"image_url": "<url or data URL>"} | {"file_id": "file-..."}]`.
  - 1–10 items; each must contain exactly one of `image_url` or `file_id`.
  - This JSON body is a Meta extension. The OpenAI SDK sends multipart with an `image` field instead. Multipart `mask`, `input_fidelity` and `partial_images` return `HTTP 400 unsupported_parameter`.
  - Several input images can be composed into one scene.
- Response: `{created, data: [{b64_json} | {url}], output_format, background: "opaque", usage}`.
- Streaming: `stream: true` sends one `image_generation.completed` or `image_edit.completed` event carrying `b64_json`.
- Strict validation, all returning `HTTP 400`: unknown top-level fields (for example `seed`), aspect ratios beyond 16:1, any `moderation` value on `muse-image-1.0`, and `content_policy_violation`. A retryable failure returns `HTTP 503`.
- The generator uses its "own fixed output resolution", so returned pixel dimensions do not follow `size`. **UNVERIFIED:** the actual resolution. Expect to upscale or outpaint for the 3840×1646 header and the 1920–3840 search images. Images are always opaque, which suits App Store "no alpha".
- Conversational mode: `POST /v1/responses` with `model: "muse-image-1.0"`. The output has `image_generation_call.result` (base64), and you refine via `previous_response_id`. Only the `image_generation` tool is allowed, with the same switches plus `size` and `output_format`.
- $0.01 per returned image; failed or filtered images are not billed. 150 RPM.
- **Not available in India** (https://dev.meta.ai/legal/geographic-use-policy). Matters for the public demo site.

## 9. SAM 3.1 (image and video segmentation)

Sources: https://dev.meta.ai/docs/media-segmentation, https://dev.meta.ai/docs/sam/overview, https://dev.meta.ai/docs/sam/segmenting, https://dev.meta.ai/docs/sam/reading-segmentation, https://dev.meta.ai/docs/sam/client-libraries.

**Request:** `POST /v1/responses`

```json
{
  "model": "sam-3.1",
  "input": [{"type": "message", "role": "user", "content": [
    {"type": "input_text", "text": "tab bar"},
    {"type": "input_image", "image_url": "data:image/png;base64,..."}
  ]}],
  "stream": true,
  "metadata": {"mask_encoding": "one_bit", "include_confidence": "true"}
}
```

**Media:**

- `input_image.image_url` takes a URL or data URL.
- `input_video.video_url` takes a URL or data URL; `input_video.file_id` takes a video uploaded with `POST /v1/files` (multipart `purpose=user_data`, `file`; optional `expires_after: {anchor: "created_at", seconds: 3600..2592000}`; files never expire by default and count toward a 100 GiB team quota) (https://dev.meta.ai/docs/file-handling).
- Video formats: MP4 or MOV with H.264, H.265 or MPEG-4. VP9 and WebM are rejected. Up to 15,000 frames (about 10 minutes).

**Prompt:** either a short noun phrase or box and point tokens, never both.

- Noun phrase: exactly one concept per request. Lists like `"bus, bicycle"` return nothing. Commands and questions are unreliable. Attributes narrow the match.
- Box and point prompts use the same token grammar as the output, for example `<0f>1<|box;x1=444;y1=626;x2=675;y2=849;w=1800;h=1200|>,2<|point;x=1430;y=700;w=1800;h=1200|>-<|point;x=1300;y=450;w=1800;h=1200|>`.
  - A leading `-` marks a negative point.
  - `w` and `h` are the media's displayed pixel size, and a mismatched aspect ratio returns `HTTP 400`.
  - At most 16 objects. Video prompts can go on any frame `<Nf>`.

**Metadata** (all values are strings):

- `mask_encoding`: `lossless` (default, `~` marker) or `one_bit` (`!` marker, several times smaller). Box and point prompts always return `one_bit`.
- `include_confidence`: `"true"` adds `c=` to each box and mask.
- `propagation_direction`: `both` (default), `forward` or `backward`. Applies to box and point prompts in video.

**Response:** the text lane holds one line per frame, one `response.output_text.delta` per frame when streaming.

```
<0f>0<|box;x1=353;y1=382;x2=453;y2=427;w=537;h=561|><|mask;x=0;y=0;data=46,101,~...|>,1<|box;...|><|mask;...|>
```

- Box corners are in source pixels, with `x2` and `y2` inclusive.
- Mask `data=H,W,<enc><base85 payload>`. The base85 alphabet and bit layout are **not documented**; decode with `@meta-sam/parser` (`decodeMaskToRaster`, zero dependencies) or the Python `meta-sam-parser`.
- Object ids are stable across frames but not dense. Frames can skip and, with `both`, arrive out of order.
- Zero matches gives an empty `output_text`, which is a valid result, not an error.
- Non-streaming requests return the same text in one response.
- **UNVERIFIED (inferred):** the mask raster seems to be cropped to the box. In every doc example `H = y2 − y1 + 1` and `W = x2 − x1 + 1`.

**Billing:** `usage.images_processed` and `usage.video_frames_processed`; $2.50 per 1,000 images; $0.20 per 1,000 frames with a 50-frame minimum per video request. 3,000 RPM.

**For Shotwright:**

- The accessibility frame of each element we tap is a ready-made box prompt. Convert points to video pixels and put it on the tap frame with `propagation_direction: "forward"`. This tracks the element for zooms and highlights with no noun-phrase guessing.
- For PII blurring, use concept prompts ("face", "email address") on stills.
- `simctl io recordVideo` writes a QuickTime movie, HEVC by default or H.264 with `--codec=h264` (`xcrun simctl io` help). MOV with H.265 or H.264 is an accepted SAM input.

## 10. Transcription (Muse Voice Transcribe)

Sources: https://dev.meta.ai/docs/speech-to-text, https://dev.meta.ai/docs/api-reference/voice/transcribe, https://dev.meta.ai/docs/api-reference/voice/schemas.

**Request:** `POST /v1/asr/transcribe` as `multipart/form-data` with two parts:

- `request`: JSON with content type `application/json`:
  - `model`: `"muse-voice-transcribe-1.0"`
  - `audioEncoding`: `"WAV"` (required, no default)
  - `mode`: `PUSH_TO_TALK` (default, single turn), `ENDPOINTING` or `DIARIZATION`
  - `keywords`: `string[]`
  - `languageBias`: language names such as `["English", "Turkish"]`
  - `partialMode` and `emitAudioProgress` apply to SSE only
- `audio`: the WAV file.

**`Accept` header:**

- `application/json` returns `{sessionId, transcript, audioDurationMs, turns: [{turnId, startMs, endMs, transcript, speaker?}]}`.
- `text/event-stream` returns realtime events.
- `text/plain` returns one turn per line.

**Audio and limits:**

- Audio must be RIFF/WAVE, mono, 16-bit PCM at 16 or 24 kHz: `ffmpeg -i in.m4a -ac 1 -ar 24000 -c:a pcm_s16le -map_metadata -1 out.wav`.
- At most 10 minutes (`HTTP 400`) and 32 MB (`HTTP 413`).
- Realtime transcription uses `wss://api.meta.ai/v1/asr/realtime`.
- 25 languages, including Turkish, with code-switching. No word-level timestamps and no text-to-speech.
- Limits are 256 concurrent streams and 16,000 streams per hour, shared with realtime; over that you get `HTTP 429`. No `x-ratelimit-*` headers (https://dev.meta.ai/docs/pricing-rate-limits).

**Other:**

- Our client builds the multipart body by hand so the `request` part matches the documented curl exactly (no filename). **UNVERIFIED** against the live endpoint.
- Alternative: Muse Spark can transcribe speech from video or audio input, but audio on 1.3 is "not fully supported" (https://dev.meta.ai/docs/models).

## 11. Rate limits, errors, regions

**Rate limits are per team, per model** (https://dev.meta.ai/docs/pricing-rate-limits):

| Model | RPM | TPM |
|---|---|---|
| `muse-wonder-1.0`, `muse-spark-1.3` / `1.2` / `1.1` | 3,000 | 4,000,000 |
| `muse-spark-1.3-contributor`, `-1.2-contributor` | 150 | 3,000,000 |
| `sam-3.1` | 3,000 | — |
| `muse-image-1.0` | 150 | — |
| `muse-voice-transcribe-1.0` | — | — (256 concurrent, 16,000 streams per hour) |

- Background responses: at most 600 submissions per minute.
- Successful token-based responses carry `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens`, `x-ratelimit-limit-requests` and `x-ratelimit-remaining-requests`.
- Retry `429` with exponential backoff plus jitter (start around 500 ms), honoring `Retry-After`.
- The cookbook README mentions different "free-tier" limits (2,400 RPM, 800,000 TPM). **UNVERIFIED** which apply to our account; read the headers.

**Errors** (https://dev.meta.ai/docs/error-handling):

- Envelope: `{"error": {"message", "type", "param", "code"}}`. Unknown paths return `404` with an **empty body**.

| Status | Meaning | Retry? |
|---|---|---|
| `400` | Bad request | No; fix the request |
| `401` | `invalid_api_key` | No |
| `402` | `billing_error` (credits or payment) | No |
| `404` | `model_not_found` | No |
| `413` | `payload_too_large` | No |
| `429` | Rate limited | Yes |
| `500` | Server error | Yes |
| `503` | `service_overloaded`, `backend_unavailable` or `server_shutting_down`, with `Retry-After` (60 s for the first two) | Yes |
| `504` | `gateway_timeout` | **No**; stream, use background mode, or reduce the work |

**Regions** (https://dev.meta.ai/legal/geographic-use-policy, dated October 12, 2026):

- Restricted territories include China (with Hong Kong and Macau), Russia, Iran, Pakistan, Venezuela and others.
- Muse Image is blocked for end users in **India**. Muse Wonder is unavailable in **South Korea** (https://dev.meta.ai/docs/models).
- Turkey is not listed.
- The console's note that the contributor model is limited to "select countries" does not appear in the public docs. **UNVERIFIED.**

**Contributor mode and user data:** content sent to `*-contributor` models may be used to train Meta models (https://dev.meta.ai/docs/pricing-rate-limits). Do not send developers' app screenshots there. Use Standard models for user projects and Contributor at most for our own demo project.

## 12. Muse Spark Open on Baseten

Source: https://dev.meta.ai/docs/muse-spark-open/deploy, plus Baseten's model page https://www.baseten.co/library/muse-spark-open.

- OpenAI-compatible. Base URL `https://inference.baseten.co/v1`, key `BASETEN_API_KEY`, model **`meta-models/muse-spark-open`**.
- Image, video and audio go in `image_url`, `video_url` and `audio_url` content parts. Send media over ~74 MB by URL.
- Full 1,048,576-token context.
- **Hackathon id:** the participant guide says the docs use `meta-models/muse-spark-open` but hackathon participants must use **`meta-models/muse-spark-open-1026`**. Public docs don't mention the suffix (Baseten's page also shows `muse-spark-open-816b-a42b`); confirm with `GET https://inference.baseten.co/v1/models` once credits arrive.
- **Price:** Baseten's page lists $1.25 input, $0.15 cached and $4.25 output per 1M tokens, which is identical to `muse-spark-1.3` Standard. Bulk transcreation is therefore no cheaper there unless Baseten credits are free. `muse-spark-1.3-contributor` ($0.10 / $0.20) is ~12–20x cheaper but has the training-data caveat and 150 RPM.
- `MuseClient` works against Baseten unchanged: `new MuseClient({ baseURL: 'https://inference.baseten.co/v1', apiKey: process.env.BASETEN_API_KEY })` and pass `model`.

## 13. The client (`packages/muse`)

Files:

- `packages/muse/package.json`: `@shotwright/muse`, ESM, `exports: ./src/index.ts`, no dependencies.
- `packages/muse/tsconfig.json`: extends `../../tsconfig.base.json`, `types: ["node"]`.
- `packages/muse/src/index.ts`
- `packages/muse/scripts/smoke.ts`

Typechecks with the repo's `tsc` (`tsc -p packages/muse`). Pure helpers and request shapes were exercised offline against a mocked `fetch`; no network call has been made.

```ts
import { MuseClient, MODELS, userMessage, jsonSchemaFormat, inputImage, computerActions, computerScreenshot, samPrompt } from '@shotwright/muse';

const muse = new MuseClient(); // MUSE_API_KEY or MODEL_API_KEY; retries 429/500/503; 300 s timeout

// Chat Completions + image + structured output
const r = await muse.chat({
  messages: [userMessage('Rank this screen for marketing value', png)],
  response_format: jsonSchemaFormat('rank', schema),
  reasoning_effort: 'low',
});
JSON.parse(r.text);

// Responses + function tools (or the native computer tool)
const t = await muse.respond({ instructions, tools: [{ type: 'computer' }], input: [{ role: 'user', content: [{ type: 'input_text', text: task }, inputImage(png)] }] });
for (const call of t.computerCalls) computerActions(call); // then: muse.respond({ previous_response_id: t.raw.id, tools, input: [computerScreenshot(call, nextPng)] })

await muse.generateImage({ prompt, size: '2100x900', output_format: 'png' }); // .images: Uint8Array[]
await muse.editImage({ prompt, images: [png], output_format: 'png' });
await muse.segment({ prompt: 'tab bar', image: png, maskEncoding: 'one_bit' }); // .frames[].objects[].box
await muse.segment({ prompt: samPrompt({ w: 1206, h: 2622 }, [{ id: 1, frame: 42, box }]), video: url, propagationDirection: 'forward' });
await muse.transcribe({ wav, languageBias: ['English'] });
await muse.post('/responses/input_tokens', { model: MODELS.spark, input }); // anything else, raw
```

Not included (add when needed): streaming (SSE), the Files API upload, the Messages API, and mask decoding (use `@meta-sam/parser`).

**Smoke test** (costs about $0.001 per run; **do not run in CI**):

```
node packages/muse/scripts/smoke.ts path/to/screenshot.png
```

It loads `MUSE_API_KEY` from the repo's `.env.local` via `process.loadEnvFile`, sends the screenshot to `muse-spark-1.3` with `reasoning_effort: "low"`, prints the description, and logs token usage and approximate cost to stderr.

## 14. Open questions and things to verify with the first real calls

1. Key format: `LLM_…_…` or `LLM|…|…` (section 1).
2. Native computer tool: `scroll` units and sign; whether a `user` message with the accessibility tree can sit next to a `computer_call_output`; whether `truncation: "auto"` is enabled for our account; whether server-state screenshots count toward the 50-image cap.
3. Does `previous_response_id` *bill* only the new turn's input tokens (section 6)?
4. Is `xhigh` the same as `high`?
5. Token cost of a 440×956 Simulator screenshot (`/v1/responses/input_tokens`), and whether `detail: "low"` changes it.
6. Muse Image's actual output resolution for `size: "2100x900"` (21:9 header) and `"1500x1000"` (3:2 search).
7. SAM: the mask raster is assumed to cover the box (inferred). Check non-streaming output for multi-frame video (are lines newline-separated?) and the latency for a 30 s clip.
8. Does `/v1/asr/transcribe` accept our hand-built multipart body?
9. Confirm `meta-models/muse-spark-open-1026` (hackathon id per the participant guide) is listed by Baseten, and whether our Baseten credit request is granted.
10. Contributor-model country restriction, and which rate-limit tier our team is on.
