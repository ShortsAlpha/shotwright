/** Cancellation helpers for explore() and replayFlow() (`signal` option). */

export function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const error = new Error(reason instanceof Error ? reason.message : "Aborted");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return (error instanceof Error && error.name === "AbortError") || signal?.aborted === true;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

/** Resolves like `promise`, or rejects with an AbortError as soon as `signal` fires (the work itself is abandoned, not stopped). */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => undefined);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** setTimeout as a promise that rejects early when the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return abortable(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);
}
