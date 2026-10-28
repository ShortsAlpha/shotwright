/**
 * Guardrails for the public site, so visitors cannot drain the model credits:
 *
 * - Explore: SHOTWRIGHT_SESSION_EXPLORE_PER_HOUR per session in any rolling hour (default 3) and
 *   SHOTWRIGHT_DAILY_EXPLORE_CAP for the whole server per UTC day (default 50; 0 turns Explore off).
 * - Captions (the one model call compose makes): SHOTWRIGHT_SESSION_CAPTIONS_PER_HOUR (default 10)
 *   and SHOTWRIGHT_DAILY_CAPTIONS_CAP (default 200).
 *
 * Rendering, previews and the zip never call a model and are not limited. Per-session windows live
 * in memory (sessions do too); the daily counters are saved to <data>/limits.json so a restart does
 * not reset them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, writeJson } from "./jobs/artifacts.ts";

export type QuotaKind = "explore" | "captions";

export interface QuotaView {
  readonly kind: QuotaKind;
  /** This session, rolling hour. */
  readonly used: number;
  readonly limit: number;
  /** When the next slot frees up (epoch ms), once the session is at its limit. */
  readonly resetAt?: number;
  /** Whole server, this UTC day. */
  readonly dailyUsed: number;
  readonly dailyLimit: number;
}

export class QuotaError extends Error {
  readonly code = "quota";
  constructor(message: string) {
    super(message);
    this.name = "QuotaError";
  }
}

const HOUR = 60 * 60_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

const LIMITS: Record<QuotaKind, { session: () => number; daily: () => number; noun: string }> = {
  explore: {
    session: () => envInt("SHOTWRIGHT_SESSION_EXPLORE_PER_HOUR", 3),
    daily: () => envInt("SHOTWRIGHT_DAILY_EXPLORE_CAP", 50),
    noun: "exploration",
  },
  captions: {
    session: () => envInt("SHOTWRIGHT_SESSION_CAPTIONS_PER_HOUR", 10),
    daily: () => envInt("SHOTWRIGHT_DAILY_CAPTIONS_CAP", 200),
    noun: "caption run",
  },
};

const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

function inWords(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60 ? `${minutes % 60} min` : ""}`.trim();
}

interface Daily {
  day: string;
  explore: number;
  captions: number;
}

export class Quotas {
  private readonly windows = new Map<string, number[]>();
  private daily: Daily;
  private readonly file: string;

  constructor(file = join(DATA_DIR, "limits.json")) {
    this.file = file;
    let saved: Partial<Daily> = {};
    try {
      saved = JSON.parse(readFileSync(file, "utf8")) as Partial<Daily>;
    } catch {
      // First run.
    }
    this.daily = saved.day === utcDay() ? { day: saved.day, explore: saved.explore ?? 0, captions: saved.captions ?? 0 } : { day: utcDay(), explore: 0, captions: 0 };
  }

  private recent(kind: QuotaKind, sessionId: string, now = Date.now()): number[] {
    const key = `${kind}:${sessionId}`;
    const list = (this.windows.get(key) ?? []).filter((t) => now - t < HOUR);
    this.windows.set(key, list);
    return list;
  }

  private today(): Daily {
    if (this.daily.day !== utcDay()) this.daily = { day: utcDay(), explore: 0, captions: 0 };
    return this.daily;
  }

  view(kind: QuotaKind, sessionId: string): QuotaView {
    const now = Date.now();
    const list = this.recent(kind, sessionId, now);
    const limit = LIMITS[kind].session();
    return {
      kind,
      used: list.length,
      limit,
      ...(list.length >= limit && list[0] !== undefined && { resetAt: list[0] + HOUR }),
      dailyUsed: this.today()[kind],
      dailyLimit: LIMITS[kind].daily(),
    };
  }

  /** Throws a QuotaError with a message for the page when `kind` is used up for this session or today. */
  check(kind: QuotaKind, sessionId: string): void {
    const v = this.view(kind, sessionId);
    const noun = LIMITS[kind].noun;
    if (v.dailyLimit === 0) {
      throw new QuotaError(
        kind === "explore"
          ? "Exploring is turned off on this server. Run Shotwright yourself (see the README) to explore your app."
          : "Writing captions with Muse is turned off on this server; the English captions are used.",
      );
    }
    if (v.dailyUsed >= v.dailyLimit) {
      const midnight = Date.parse(`${utcDay()}T00:00:00Z`) + 24 * HOUR;
      throw new QuotaError(
        `This server has reached today's limit of ${v.dailyLimit} ${noun}s, which keeps the public demo within its model budget. ` +
          `It resets at midnight UTC (in ${inWords(midnight - Date.now())}); run Shotwright yourself to go on now.`,
      );
    }
    if (v.used >= v.limit) {
      const wait = v.resetAt !== undefined ? ` The next one is available in ${inWords(v.resetAt - Date.now())}.` : "";
      throw new QuotaError(`You have used the ${v.limit} ${noun}s this session gets per hour.${wait}`);
    }
  }

  /** Counts one use (after `check`). */
  consume(kind: QuotaKind, sessionId: string): void {
    this.recent(kind, sessionId).push(Date.now());
    this.today()[kind]++;
    void writeJson(this.file, this.daily).catch(() => undefined);
  }

  /** Session ended. */
  forget(sessionId: string): void {
    for (const kind of Object.keys(LIMITS) as QuotaKind[]) this.windows.delete(`${kind}:${sessionId}`);
  }
}

const KEY = Symbol.for("shotwright.quotas");

export function getQuotas(): Quotas {
  const store = globalThis as typeof globalThis & { [KEY]?: Quotas };
  return (store[KEY] ??= new Quotas());
}
