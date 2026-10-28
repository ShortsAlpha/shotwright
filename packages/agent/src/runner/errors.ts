/** Errors raised by the runner client. */

/** The runner answered with `ok: false` or a non-2xx status. */
export class RunnerError extends Error {
  readonly route: string;
  readonly status: number | undefined;

  constructor(route: string, message: string, status?: number) {
    super(`${route}: ${message}`);
    this.name = "RunnerError";
    this.route = route;
    this.status = status;
  }
}

/** A request did not finish within its per-request timeout. */
export class RunnerTimeoutError extends RunnerError {
  readonly timeoutMs: number;

  constructor(route: string, timeoutMs: number) {
    super(route, `no answer within ${timeoutMs} ms`);
    this.name = "RunnerTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The runner stopped answering and was restarted while an action was in flight.
 * The action may or may not have happened: observe the screen again before acting.
 */
export class RunnerRestartedError extends RunnerError {
  constructor(route: string) {
    super(route, "runner hung and was restarted; the action may or may not have run, observe again");
    this.name = "RunnerRestartedError";
  }
}

/** The runner could not be built or started. */
export class RunnerStartError extends Error {
  readonly logPath: string | undefined;

  constructor(message: string, logPath?: string) {
    super(logPath ? `${message} (log: ${logPath})` : message);
    this.name = "RunnerStartError";
    this.logPath = logPath;
  }
}
