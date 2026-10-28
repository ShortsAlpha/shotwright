/**
 * Runtime checks for call params. The server is trusted to send well-formed calls, but values end
 * up as command-line arguments, so anything that could be read as an option is rejected here.
 */
import type { ElementSelector, LaunchOptions, Point, SwipeGesture, TapTarget } from "@shotwright/core";

/** An error returned to the server as `{ ok: false, error: { message, code } }`. */
export class AgentError extends Error {
  readonly code: string;

  constructor(message: string, code = "bad_request") {
    super(message);
    this.name = "AgentError";
    this.code = code;
  }
}

type Obj = Record<string, unknown>;

export function asObject(params: unknown): Obj {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) throw new AgentError("Params must be an object");
  return params as Obj;
}

export function str(obj: Obj, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value === "") throw new AgentError(`"${key}" must be a non-empty string`);
  return value;
}

export function optStr(obj: Obj, key: string): string | undefined {
  return obj[key] === undefined ? undefined : str(obj, key);
}

export function optNum(obj: Obj, key: string, min: number, max: number): number | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new AgentError(`"${key}" must be a number from ${min} to ${max}`);
  }
  return value;
}

/** A command-line value that must not start with "-". */
export function arg(obj: Obj, key: string): string {
  const value = str(obj, key);
  if (value.startsWith("-")) throw new AgentError(`"${key}" must not start with "-"`);
  return value;
}

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

export function udid(params: unknown): string {
  const value = str(asObject(params), "udid");
  if (!UDID.test(value)) throw new AgentError(`Not a simulator UDID: ${value}`);
  return value;
}

export function absolutePath(obj: Obj, key: string, extensions: readonly string[]): string {
  const value = str(obj, key);
  if (!value.startsWith("/")) throw new AgentError(`"${key}" must be an absolute path`);
  if (!extensions.some((ext) => value.endsWith(ext))) {
    throw new AgentError(`"${key}" must end with ${extensions.join(" or ")}`);
  }
  return value;
}

function point(value: unknown, key: string): Point {
  const obj = asObject(value);
  const x = optNum(obj, "x", -10_000, 10_000);
  const y = optNum(obj, "y", -10_000, 10_000);
  if (x === undefined || y === undefined) throw new AgentError(`"${key}" must be a point { x, y }`);
  return { x, y };
}

export function selector(value: unknown): ElementSelector {
  const obj = asObject(value);
  const id = optStr(obj, "id");
  const label = optStr(obj, "label");
  if (id === undefined && label === undefined) throw new AgentError("A selector needs an id or a label");
  return { ...(id !== undefined && { id }), ...(label !== undefined && { label }) };
}

export function tapTarget(params: unknown): TapTarget {
  const obj = asObject(params);
  return "x" in obj || "y" in obj ? point(obj, "target") : selector(obj);
}

const DIRECTIONS = new Set(["up", "down", "left", "right"]);

export function swipeGesture(params: unknown): SwipeGesture {
  const obj = asObject(params);
  if ("direction" in obj) {
    const direction = str(obj, "direction");
    if (!DIRECTIONS.has(direction)) throw new AgentError(`Unknown swipe direction: ${direction}`);
    return {
      direction: direction as "up" | "down" | "left" | "right",
      ...(obj.within !== undefined && { within: selector(obj.within) }),
    };
  }
  const durationMs = optNum(obj, "durationMs", 0, 10_000);
  return {
    from: point(obj.from, "from"),
    to: point(obj.to, "to"),
    ...(durationMs !== undefined && { durationMs }),
  };
}

export function launchOptions(params: unknown): LaunchOptions {
  const obj = asObject(params);
  const bundleId = arg(obj, "bundleId");
  const args = obj.args;
  if (args !== undefined && (!Array.isArray(args) || !args.every((a) => typeof a === "string"))) {
    throw new AgentError('"args" must be an array of strings');
  }
  const env = obj.env;
  if (
    env !== undefined &&
    (typeof env !== "object" || env === null || !Object.values(env).every((v) => typeof v === "string"))
  ) {
    throw new AgentError('"env" must be an object of strings');
  }
  return {
    bundleId,
    ...(args !== undefined && { args: args as string[] }),
    ...(env !== undefined && { env: env as Record<string, string> }),
  };
}
