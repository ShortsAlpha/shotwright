"use client";

import { useEffect, useRef } from "react";
import type { LogEntry } from "../../lib/ui-protocol.ts";

const LEVEL_TEXT: Record<LogEntry["level"], string> = {
  info: "text-neutral-700 dark:text-neutral-300",
  warn: "text-amber-700 dark:text-amber-400",
  error: "text-red-600 dark:text-red-400",
};

const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour12: false });

export function LogPanel({ logs, onClear, className = "" }: { logs: readonly LogEntry[]; onClear: () => void; className?: string }) {
  const list = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);

  // Follow new entries unless the user scrolled up to read.
  useEffect(() => {
    const el = list.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <section className={`flex min-h-0 flex-col rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900 ${className}`}>
      <header className="flex items-center justify-between border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
        <h2 className="text-sm font-semibold">Activity</h2>
        <button type="button" onClick={onClear} className="text-xs font-medium text-neutral-500 hover:text-neutral-900 dark:hover:text-white">
          Clear
        </button>
      </header>
      <ol
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="min-h-32 flex-1 space-y-1 overflow-y-auto px-4 py-3 font-mono text-[11.5px] leading-relaxed"
      >
        {logs.length === 0 && <li className="text-neutral-400">Nothing yet.</li>}
        {logs.map((entry) => (
          <li key={entry.id} className="flex gap-2">
            <span className="shrink-0 text-neutral-400 tabular-nums">{time(entry.ts)}</span>
            <span
              className={`shrink-0 rounded px-1 text-[10px] font-semibold uppercase leading-[18px] ${
                entry.source === "agent"
                  ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300"
                  : "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
              }`}
            >
              {entry.source === "agent" ? "mac" : "web"}
            </span>
            <span className={`min-w-0 break-words ${LEVEL_TEXT[entry.level]}`}>{entry.message}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
