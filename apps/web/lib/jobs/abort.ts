/**
 * Cancelling a job. Nothing in the explorer takes an AbortSignal, so the job hands it a driver and a
 * provider whose every call fails once the signal fires: the explorer's loop then ends at its next
 * device or model call. The call already sent to the Mac (or the model) still finishes there; its
 * result is dropped.
 */
import type { DeviceDriver, ElementSelector, LaunchOptions, ScreenInfo, SwipeGesture, TapTarget, UISnapshot } from "@shotwright/core";
import type { ExplorerProvider, ProviderTurn, TurnRequest, Usage } from "@shotwright/explorer";
import type { RemoteDriver } from "../realtime/remote-driver.ts";

export class JobCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "JobCancelled";
  }
}

/** Resolves like `promise`, or rejects with JobCancelled as soon as `signal` fires. */
export function abortable<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(new JobCancelled());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new JobCancelled());
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

/** Where the agent touched the screen, in points (for the live view's tap ripples). */
export type TouchListener = (point: { x: number; y: number }) => void;

/** The session's RemoteDriver, cut off when the job is cancelled. Reports taps and swipe starts. */
export class CancellableDriver implements DeviceDriver {
  private readonly inner: RemoteDriver;
  private readonly signal: AbortSignal;
  private readonly onTouch: TouchListener | undefined;

  constructor(inner: RemoteDriver, signal: AbortSignal, onTouch?: TouchListener) {
    this.inner = inner;
    this.signal = signal;
    this.onTouch = onTouch;
  }

  private run<T>(call: () => Promise<T>): Promise<T> {
    if (this.signal.aborted) return Promise.reject(new JobCancelled());
    return abortable(this.signal, call());
  }

  screen(): Promise<ScreenInfo> {
    return this.run(() => this.inner.screen());
  }

  launch(options: LaunchOptions): Promise<void> {
    return this.run(() => this.inner.launch(options));
  }

  terminate(bundleId?: string): Promise<void> {
    return this.run(() => this.inner.terminate(bundleId));
  }

  home(): Promise<void> {
    return this.run(() => this.inner.home());
  }

  source(bundleId?: string): Promise<UISnapshot> {
    return this.run(() => this.inner.source(bundleId));
  }

  /** The explorer's `stableSource` uses this when present (one call instead of polling). */
  waitForStable(options: { bundleId?: string; timeoutMs?: number } = {}): Promise<UISnapshot> {
    return this.run(() => this.inner.waitForStable(options));
  }

  screenshot(): Promise<Uint8Array> {
    return this.run(() => this.inner.screenshot());
  }

  tap(target: TapTarget): Promise<void> {
    if ("x" in target && !this.signal.aborted) this.onTouch?.({ x: target.x, y: target.y });
    return this.run(() => this.inner.tap(target));
  }

  swipe(gesture: SwipeGesture): Promise<void> {
    if ("from" in gesture && !this.signal.aborted) this.onTouch?.(gesture.from);
    return this.run(() => this.inner.swipe(gesture));
  }

  typeText(text: string, into?: ElementSelector): Promise<void> {
    return this.run(() => this.inner.typeText(text, into));
  }

  statusBar(override: boolean): Promise<void> {
    return this.run(() => this.inner.statusBar(override));
  }
}

/**
 * Wraps a provider so its turns stop when the job is cancelled, and reports every reply with the
 * run's total usage and cost (the explorer's events carry neither).
 */
export function trackProvider(
  provider: ExplorerProvider,
  signal: AbortSignal,
  onReply: (reply: ProviderTurn, total: Usage, costUsd: number) => void,
): ExplorerProvider {
  const total = { input: 0, cachedInput: 0, output: 0, reasoning: 0 };
  return {
    id: provider.id,
    model: provider.model,
    mode: provider.mode,
    cost: (usage) => provider.cost(usage),
    listCost: (usage) => provider.listCost(usage),
    async next(request: TurnRequest): Promise<ProviderTurn> {
      const reply = await abortable(signal, provider.next(request));
      total.input += reply.usage.input;
      total.cachedInput += reply.usage.cachedInput;
      total.output += reply.usage.output;
      total.reasoning += reply.usage.reasoning;
      onReply(reply, { ...total }, provider.cost(total));
      return reply;
    },
  };
}
