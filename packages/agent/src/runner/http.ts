/** Minimal HTTP client for ShotwrightRunner (ios/ShotwrightRunner/README.md) with per-request timeouts. */
import { RunnerError, RunnerTimeoutError } from "./errors.ts";

export class RunnerHttp {
  readonly baseUrl: string;

  constructor(port = 8615, host = "127.0.0.1") {
    this.baseUrl = `http://${host}:${port}`;
  }

  /** JSON request. Throws RunnerTimeoutError, or RunnerError when the runner answers `ok: false`. */
  async json<T = Record<string, unknown>>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const response = await this.#fetch(method, path, body, timeoutMs);
    const text = await response.text();
    let parsed: { ok?: boolean; error?: string } & Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new RunnerError(path, `HTTP ${response.status}, not JSON: ${text.slice(0, 200)}`, response.status);
    }
    if (!response.ok || parsed.ok === false) {
      throw new RunnerError(path, parsed.error ?? `HTTP ${response.status}`, response.status);
    }
    return parsed as T;
  }

  /** Binary GET (screenshots). */
  async bytes(path: string, timeoutMs: number): Promise<Uint8Array> {
    const response = await this.#fetch("GET", path, undefined, timeoutMs);
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) {
      throw new RunnerError(path, `HTTP ${response.status}: ${new TextDecoder().decode(buffer.slice(0, 300))}`, response.status);
    }
    return buffer;
  }

  async #fetch(method: string, path: string, body: unknown, timeoutMs: number): Promise<Response> {
    try {
      return await fetch(this.baseUrl + path, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") throw new RunnerTimeoutError(path, timeoutMs);
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      throw new RunnerError(path, `request failed${cause ? ` (${cause})` : ""}: ${(error as Error).message}`);
    }
  }
}
