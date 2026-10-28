"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  artifactUrl,
  localeName,
  modelLabel,
  type CallView,
  type JobPhase,
  type JobsSnapshot,
  type RunView,
  type StepView,
} from "../../lib/jobs/state.ts";
import {
  AlertIcon,
  BookmarkIcon,
  CheckIcon,
  FlagIcon,
  KeyboardIcon,
  PointerIcon,
  RefreshIcon,
  SparkleIcon,
  Spinner,
  SwipeIcon,
} from "../_components/icons.tsx";

const EXPLORE_PHASES: ReadonlyArray<{ phase: JobPhase; label: string; also?: JobPhase[] }> = [
  { phase: "build", label: "Build" },
  { phase: "install", label: "Install", also: ["runner"] },
  { phase: "explore", label: "Explore" },
  { phase: "verify", label: "Verify" },
  { phase: "judge", label: "Rank" },
];

export const formatUsd = (usd: number) => (usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`);
export const formatTokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const formatSeconds = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${Math.max(0, Math.round(ms / 1000))} s`);

/** Re-renders every `ms` while `on`. */
export function useNow(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [on, ms]);
  return now;
}

function PhaseStepper({ jobs }: { jobs: JobsSnapshot }) {
  const job = jobs.job!;
  const current = EXPLORE_PHASES.findIndex((p) => p.phase === job.phase || p.also?.includes(job.phase!));
  const finished = job.status === "done";
  return (
    <ol className="flex flex-wrap items-center gap-1 text-[11px] font-medium">
      {EXPLORE_PHASES.map((p, i) => {
        const done = finished || i < current;
        const active = !finished && i === current;
        const broken = active && (job.status === "failed" || job.status === "cancelled");
        return (
          <li key={p.phase}>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ${
                broken
                  ? "bg-red-50 text-red-600 dark:bg-red-950/50 dark:text-red-400"
                  : active
                    ? "bg-indigo-600 text-white"
                    : done
                      ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300"
                      : "bg-neutral-100 text-neutral-400 dark:bg-neutral-800"
              }`}
            >
              {active && !broken && <Spinner className="size-3" />}
              {done && <CheckIcon className="size-3" />}
              {p.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Element description from the explorer's output: `Tapped e10 (button "Netflix, …").` */
function tappedElement(output: string | undefined): string | undefined {
  const match = output && /^Tapped (?:e\d+ \((.*)\)|at \((\d+,\d+)\)(?: on "(.*?)")?)/.exec(output);
  if (!match) return undefined;
  // `button "Netflix, $15.49" #row.netflix`: the label says enough; the identifier only without one.
  if (match[1]) return match[1].includes('"') ? match[1].replace(/ #\S+$/, "") : match[1];
  return match[3] ? `"${match[3]}"` : `(${match[2]})`;
}

const failed = (output: string | undefined) => output !== undefined && /^(Error|Action failed|Not executed)/.test(output);
const unchanged = (output: string | undefined) => output?.includes("The screen did not change.") ?? false;

function CallLine({ call }: { call: CallView }) {
  const args = call.args as Record<string, unknown>;
  const reason = typeof args.reason === "string" ? args.reason : undefined;
  let icon: ReactNode = <PointerIcon className="size-3.5" />;
  let title: ReactNode;
  switch (call.name) {
    case "tap": {
      const element = tappedElement(call.output);
      title = (
        <>
          Tap <span className="font-normal text-neutral-600 dark:text-neutral-300">{element ?? String(args.element_id ?? "")}</span>
        </>
      );
      break;
    }
    case "tap_at": {
      const element = tappedElement(call.output);
      title = (
        <>
          Tap <span className="font-normal text-neutral-600 dark:text-neutral-300">{element ?? `(${String(args.x)}, ${String(args.y)})`}</span>
        </>
      );
      break;
    }
    case "swipe":
      icon = <SwipeIcon className={`size-3.5 ${args.direction === "down" ? "rotate-180" : args.direction === "left" ? "-rotate-90" : args.direction === "right" ? "rotate-90" : ""}`} />;
      title = <>Swipe {typeof args.direction === "string" ? args.direction : ""}</>;
      break;
    case "type_text":
      icon = <KeyboardIcon className="size-3.5" />;
      title = (
        <>
          Type <span className="font-normal text-neutral-600 dark:text-neutral-300">“{String(args.text ?? "")}”</span>
        </>
      );
      break;
    case "relaunch":
      icon = <RefreshIcon className="size-3.5" />;
      title = <>Relaunch the app</>;
      break;
    default:
      title = <>{call.name}</>;
  }
  const bad = failed(call.output);
  return (
    <div>
      <div className={`flex items-start gap-1.5 text-[13px] font-medium ${bad ? "text-amber-700 dark:text-amber-400" : ""}`}>
        <span className={`mt-0.5 shrink-0 ${bad ? "" : "text-indigo-500"}`}>{bad ? <AlertIcon className="size-3.5" /> : icon}</span>
        <span className="min-w-0 break-words">{title}</span>
        {unchanged(call.output) && <span className="shrink-0 rounded bg-neutral-100 px-1 text-[10px] font-medium text-neutral-500 dark:bg-neutral-800">no change</span>}
      </div>
      {reason && <p className="mt-0.5 pl-5 text-xs leading-snug text-neutral-500">{reason}</p>}
      {bad && call.output && <p className="mt-0.5 pl-5 text-xs leading-snug text-amber-700/90 dark:text-amber-400/90">{call.output.slice(0, 200)}</p>}
    </div>
  );
}

function MarkLine({ call }: { call: CallView }) {
  const args = call.args as Record<string, unknown>;
  const score = Number(args.marketing_score ?? args.score);
  const ok = call.output === undefined || call.output.startsWith("Marked");
  return (
    <div className={`rounded-lg border px-2.5 py-1.5 ${ok ? "border-emerald-200 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/30" : "border-neutral-200 dark:border-neutral-700"}`}>
      <div className="flex items-center gap-1.5 text-[13px] font-medium text-emerald-800 dark:text-emerald-300">
        <BookmarkIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">Marked {String(args.name ?? "")}</span>
        {Number.isFinite(score) && <span className="ml-auto shrink-0 font-semibold tabular-nums">{score}/10</span>}
      </div>
      {typeof args.why === "string" && <p className="mt-0.5 pl-5 text-xs leading-snug text-emerald-900/70 dark:text-emerald-200/70">{args.why}</p>}
      {!ok && <p className="mt-0.5 pl-5 text-xs text-neutral-500">{call.output}</p>}
    </div>
  );
}

function StepRow({ step }: { step: StepView }) {
  const marks = step.calls.filter((c) => c.name === "mark_screen");
  const actions = step.calls.filter((c) => c.name !== "mark_screen" && c.name !== "done");
  const done = step.calls.find((c) => c.name === "done");
  return (
    <li className="flex gap-3 px-4 py-2.5">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-[10px] font-semibold text-neutral-500 tabular-nums dark:bg-neutral-800 dark:text-neutral-400">
        {step.turn}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        {marks.map((c, i) => (
          <MarkLine key={`m${i}`} call={c} />
        ))}
        {actions.map((c, i) => (
          <CallLine key={`a${i}`} call={c} />
        ))}
        {done && (
          <div className="flex items-center gap-1.5 text-[13px] font-medium">
            <FlagIcon className="size-3.5 text-indigo-500" /> Done exploring
          </div>
        )}
        {step.calls.length === 0 && step.text && <p className="text-xs italic text-neutral-500">“{step.text.slice(0, 200)}”</p>}
        {step.reasoning && (
          <details className="group text-xs text-neutral-500">
            <summary className="cursor-pointer list-none select-none font-medium text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300">
              <span className="inline-block transition group-open:rotate-90">›</span> Thinking
            </summary>
            <p className="mt-1 whitespace-pre-wrap leading-snug">{step.reasoning}</p>
          </details>
        )}
      </div>
      {step.modelMs !== undefined && <span className="shrink-0 pt-0.5 text-[11px] text-neutral-400 tabular-nums">{(step.modelMs / 1000).toFixed(1)} s</span>}
    </li>
  );
}

function MarkedStrip({ run }: { run: RunView }) {
  return (
    <div className="border-t border-neutral-100 px-4 py-3 dark:border-neutral-800">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="font-semibold">Marked screens</span>
        <span className="text-neutral-500 tabular-nums">{run.marks.length}</span>
      </div>
      <ul className="flex gap-2 overflow-x-auto pb-1">
        {run.marks.map((m) => (
          <li key={m.name} className="shrink-0">
            <a href={artifactUrl(run.runId, m.image)} target="_blank" rel="noreferrer" title={`${m.name}: ${m.why}`} className="group relative block">
              <img
                src={artifactUrl(run.runId, m.thumb, run.runId)}
                alt={m.name}
                className="mark-in h-24 w-auto rounded-lg border border-neutral-200 bg-neutral-100 shadow-sm transition group-hover:border-indigo-300 dark:border-neutral-700"
              />
              <span className="absolute right-1 top-1 rounded-md bg-neutral-900/75 px-1 text-[10px] font-semibold text-white tabular-nums">{m.score}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AgentPanel({ jobs, className = "" }: { jobs: JobsSnapshot; className?: string }) {
  const { job, run } = jobs;
  const list = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  const running = job?.status === "running" || job?.status === "cancelling";
  const now = useNow(running);
  const explore = job?.kind === "explore";

  useEffect(() => {
    const el = list.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [run?.steps, run?.summary, job?.phase]);

  const lastTurn = run?.steps.at(-1)?.turn ?? 0;
  const preExplore = running && explore && (job.phase === undefined || job.phase === "build" || job.phase === "runner" || job.phase === "install");

  let status: ReactNode = null;
  if (job && running) {
    const replaying = job.kind === "replay" ? run?.replays.find((r) => r.status === "running") : undefined;
    const position = replaying && job.locales ? job.locales.indexOf(replaying.locale) + 1 : 0;
    status =
      job.status === "cancelling"
        ? "Stopping…"
        : job.phase === "explore"
          ? `Turn ${lastTurn} of ${run?.maxTurns ?? 40}`
          : replaying && job.locales
            ? `Replaying in ${localeName(replaying.locale)} · ${position} of ${job.locales.length}`
            : `${job.phaseLabel ?? "Starting"}${job.phaseAt ? ` · ${formatSeconds(now - job.phaseAt)}` : ""}`;
  } else if (job?.status === "done" && run?.summary) {
    status = `${run.marks.length} screens · ${run.summary.turns} turns · ${formatSeconds(run.summary.totalMs)}`;
  } else if (job?.status === "cancelled") {
    status = "Stopped";
  } else if (job?.status === "failed") {
    status = "Failed";
  }

  return (
    <section className={`flex min-h-0 flex-col rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900 ${className}`}>
      <header className="space-y-2.5 border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="text-sm font-semibold">Agent</h2>
            {run && (
              <span className="inline-flex items-center gap-1 truncate rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300">
                <SparkleIcon className="size-3" /> {modelLabel(run.model)}
              </span>
            )}
          </div>
          {run && (run.costUsd > 0 || run.steps.length > 0) && (
            <span className="shrink-0 text-xs tabular-nums" title={`${run.usage.input.toLocaleString()} input tokens (${run.usage.cachedInput.toLocaleString()} cached), ${run.usage.output.toLocaleString()} output`}>
              <span className="font-semibold">{formatUsd(run.costUsd)}</span>
              <span className="text-neutral-500"> · {formatTokens(run.usage.input + run.usage.output)} tokens</span>
            </span>
          )}
        </div>
        {job && explore && <PhaseStepper jobs={jobs} />}
        {status && <p className="text-xs text-neutral-500 tabular-nums">{status}</p>}
      </header>

      <ol
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
        }}
        className="min-h-40 flex-1 divide-y divide-neutral-100 overflow-y-auto dark:divide-neutral-800/70"
      >
        {!run && (
          <li className="px-4 py-6 text-sm leading-relaxed text-neutral-500">
            Pick a project and press <strong className="font-semibold text-neutral-700 dark:text-neutral-300">Explore</strong>. The agent drives your app,
            says what it does at each step and marks the screens worth a screenshot.
          </li>
        )}
        {preExplore && (
          <li className="flex items-center gap-2 px-4 py-4 text-sm text-neutral-500">
            <Spinner className="size-4" /> {job.phaseLabel ?? "Starting"}…
          </li>
        )}
        {run?.steps.map((step) => (
          <StepRow key={step.turn} step={step} />
        ))}
        {running && job.phase === "explore" && (
          <li className="flex items-center gap-2 px-4 py-2.5 text-xs text-neutral-400">
            <Spinner className="size-3.5" /> Looking at the screen…
          </li>
        )}
        {run?.summary && <SummaryRow run={run} />}
        {job?.status === "failed" && job.error && (
          <li className="px-4 py-3">
            <div className="flex gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              <AlertIcon className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{job.error}</span>
            </div>
          </li>
        )}
      </ol>

      {run && run.marks.length > 0 && <MarkedStrip run={run} />}
    </section>
  );
}

function SummaryRow({ run }: { run: RunView }) {
  const s = run.summary!;
  const checked = s.verified.length + s.failed.length;
  return (
    <li className="space-y-1 bg-neutral-50/70 px-4 py-3 text-xs text-neutral-600 dark:bg-neutral-950/30 dark:text-neutral-400">
      <p className="font-medium text-neutral-800 dark:text-neutral-200">
        {s.stoppedBecause === "done" ? "Finished" : `Stopped (${s.stoppedBecause.replace("_", " ")})`}: {run.marks.length} screens in {s.turns} turns, {formatUsd(s.costUsd)}
      </p>
      <p>
        Recorded a flow of {s.flowSteps} steps
        {checked > 0 && (
          <>
            {" "}
            · replayed and verified{" "}
            <span className={s.failed.length ? "font-medium text-amber-700 dark:text-amber-400" : "font-medium text-emerald-700 dark:text-emerald-400"}>
              {s.verified.length} of {checked}
            </span>
          </>
        )}
      </p>
      {s.notes && <p className="italic">“{s.notes}”</p>}
      {s.error && <p className="text-red-600 dark:text-red-400">{s.error}</p>}
    </li>
  );
}
