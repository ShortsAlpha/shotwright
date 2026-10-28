"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Spinner } from "./icons.tsx";

/** How developers start the agent. Update when the agent is published to npm. */
export const AGENT_COMMAND = "npm run agent -- connect";

const CODE_LENGTH = 6;
const clean = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LENGTH);

export function PairForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function pair(value: string) {
    if (value.length !== CODE_LENGTH || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: value }),
      });
      const body = (await res.json()) as { sessionId?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Pairing failed");
      router.push("/session");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPending(false);
    }
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void pair(code);
  };

  return (
    <form onSubmit={onSubmit} className="mt-4">
      <label htmlFor="pairing-code" className="sr-only">
        Pairing code
      </label>
      <div className="flex gap-2">
        <input
          id="pairing-code"
          value={code}
          onChange={(e) => {
            const next = clean(e.target.value);
            setCode(next);
            setError(null);
            if (next.length === CODE_LENGTH) void pair(next);
          }}
          placeholder="K7P4XM"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          autoFocus
          className="w-full min-w-0 rounded-xl border border-neutral-300 bg-white px-4 py-3 text-center font-mono text-2xl font-semibold uppercase tracking-[0.4em] placeholder:text-neutral-300 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/15 focus:outline-none dark:border-neutral-700 dark:bg-neutral-950 dark:placeholder:text-neutral-700"
        />
        <button
          type="submit"
          disabled={code.length !== CODE_LENGTH || pending}
          className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-indigo-600 px-5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending && <Spinner />}
          Connect
        </button>
      </div>
      <p className={`mt-2 min-h-5 text-sm ${error ? "text-red-600 dark:text-red-400" : "text-neutral-500"}`} role={error ? "alert" : undefined}>
        {error ?? "The code is shown by the agent and expires after 10 minutes."}
      </p>
    </form>
  );
}
