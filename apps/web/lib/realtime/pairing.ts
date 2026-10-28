import { randomInt } from "node:crypto";

/** No 0/O, 1/I/L: easy to read off a terminal and type. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 6;
export const PAIRING_TTL_MS = 10 * 60_000;

export function generateCode(isTaken: (code: string) => boolean): string {
  for (;;) {
    let code = "";
    for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    if (!isTaken(code)) return code;
  }
}

/** Uppercases and drops spaces, dashes and anything else outside the alphabet. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Counts failed attempts per client so codes cannot be guessed by brute force. */
export class AttemptLimiter {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  blocked(key: string): boolean {
    const entry = this.failures.get(key);
    if (!entry) return false;
    if (entry.resetAt < Date.now()) {
      this.failures.delete(key);
      return false;
    }
    return entry.count >= this.max;
  }

  fail(key: string): void {
    const now = Date.now();
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt < now) this.failures.set(key, { count: 1, resetAt: now + this.windowMs });
    else entry.count++;
  }

  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.failures) if (entry.resetAt < now) this.failures.delete(key);
  }
}
