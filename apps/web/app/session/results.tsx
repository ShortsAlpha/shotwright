"use client";

import { artifactUrl, isActive, localeName, rankedScreens, type JobsSnapshot, type LocaleRun, type RunView } from "../../lib/jobs/state.ts";
import type { SessionState } from "../../lib/ui-protocol.ts";
import { AlertIcon, CheckIcon, GlobeIcon, PlayIcon, SparkleIcon, Spinner } from "../_components/icons.tsx";
import { formatSeconds } from "./agent-panel.tsx";
import { ComposePanel } from "./compose-panel.tsx";
import type { JobFn } from "./use-session.ts";

const card = "rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900";

function Picks({ run }: { run: RunView }) {
  const screens = rankedScreens(run);
  const judge = run.judge;
  const judged = judge && "ranking" in judge;
  return (
    <section className={card}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-neutral-100 px-5 py-3.5 dark:border-neutral-800">
        <div>
          <h2 className="text-sm font-semibold">Picks</h2>
          <p className="text-xs text-neutral-500">
            {judged
              ? `Ranked and captioned by ${judge.model.replace(/^meta-models\//, "")} in ${(judge.ms / 1000).toFixed(0)} s. The first three show in App Store search.`
              : judge?.skipped
                ? `In the explorer's order. ${judge.skipped}`
                : "In the explorer's order; the judge is ranking them…"}
          </p>
        </div>
        {judged && judge.notes && <p className="max-w-xl text-xs italic text-neutral-500">“{judge.notes}”</p>}
      </header>
      <ol className="grid grid-cols-2 gap-x-4 gap-y-5 p-5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-8">
        {screens.map(({ mark, judged: j, rank }) => (
          <li key={mark.name} className="mark-in min-w-0">
            <a href={artifactUrl(run.runId, mark.image)} target="_blank" rel="noreferrer" className="group relative block">
              <img
                src={artifactUrl(run.runId, mark.thumb, run.runId)}
                alt={mark.name}
                className={`w-full rounded-[1.1rem] border bg-neutral-100 shadow-sm transition group-hover:shadow-md dark:bg-neutral-800 ${
                  rank <= 3 ? "border-indigo-200 dark:border-indigo-800" : "border-neutral-200 dark:border-neutral-700"
                }`}
              />
              <span
                className={`absolute left-2 top-2 rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${
                  rank <= 3 ? "bg-indigo-600 text-white" : "bg-neutral-900/70 text-white"
                }`}
              >
                #{rank}
              </span>
            </a>
            <div className="mt-2 space-y-0.5">
              <p className="text-[13px] font-semibold leading-snug">{j?.caption || mark.name.replace(/-/g, " ")}</p>
              <p className="flex items-center gap-1.5 text-[11px] text-neutral-500">
                <span className="truncate font-mono">{mark.name}</span>
                <span className="ml-auto shrink-0 tabular-nums">{j ? j.score : mark.score}/10</span>
              </p>
              <p className="line-clamp-3 text-[11px] leading-snug text-neutral-500" title={j ? `Judge: ${j.reason}\nExplorer: ${mark.why}` : mark.why}>
                {j?.reason || mark.why}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function LocaleRow({ runId, replay }: { runId: string; replay: LocaleRun }) {
  const verified = replay.shots.filter((s) => s.verified).length;
  const percent = replay.total ? Math.round((replay.step / replay.total) * 100) : 0;
  let status;
  switch (replay.status) {
    case "pending":
      status = <span className="text-neutral-400">Waiting</span>;
      break;
    case "running":
      status = (
        <span className="inline-flex items-center gap-1.5 text-indigo-600 dark:text-indigo-400">
          <Spinner className="size-3" /> Step {replay.step} of {replay.total}
        </span>
      );
      break;
    case "done":
      status = (
        <span className={`inline-flex items-center gap-1 ${verified === replay.shots.length ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}`}>
          {verified === replay.shots.length ? <CheckIcon className="size-3.5" /> : <AlertIcon className="size-3.5" />}
          {verified}/{replay.shots.length} verified{replay.ms !== undefined && <span className="text-neutral-400"> · {formatSeconds(replay.ms)}</span>}
        </span>
      );
      break;
    case "cancelled":
      status = <span className="text-neutral-500">Stopped</span>;
      break;
    case "failed":
      status = (
        <span className="text-red-600 dark:text-red-400" title={replay.error}>
          Failed
        </span>
      );
      break;
  }
  return (
    <li className="grid grid-cols-1 gap-3 px-5 py-3.5 md:grid-cols-[180px_minmax(0,1fr)] md:items-center">
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-semibold">{localeName(replay.locale)}</span>
          <span className="font-mono text-[11px] text-neutral-400">{replay.locale}</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
          <div
            className={`h-full rounded-full transition-all duration-500 ${replay.status === "done" ? "bg-emerald-500" : replay.status === "failed" ? "bg-red-500" : "bg-indigo-500"}`}
            style={{ width: `${replay.status === "done" ? 100 : percent}%` }}
          />
        </div>
        <p className="text-xs">{status}</p>
      </div>
      <ul className="flex min-h-24 gap-2 overflow-x-auto pb-1">
        {replay.shots.map((shot) => (
          <li key={shot.name} className="mark-in relative shrink-0">
            <a href={artifactUrl(runId, shot.image, replay.version)} target="_blank" rel="noreferrer" title={`${shot.name}${shot.verified ? "" : " (not verified)"}`}>
              {shot.thumb ? (
                <img
                  src={artifactUrl(runId, shot.thumb, replay.version)}
                  alt={`${shot.name} in ${localeName(replay.locale)}`}
                  className={`h-28 w-auto rounded-lg border bg-neutral-100 dark:bg-neutral-800 ${shot.verified ? "border-neutral-200 dark:border-neutral-700" : "border-amber-400 ring-2 ring-amber-300/50"}`}
                />
              ) : (
                <span className="flex h-28 w-14 items-center justify-center rounded-lg border border-dashed border-neutral-300 text-[10px] text-neutral-400">{shot.name}</span>
              )}
            </a>
            {!shot.verified && (
              <span className="absolute right-1 top-1 rounded-full bg-amber-400 p-0.5 text-white" title="The replay did not reach the same screen">
                <AlertIcon className="size-2.5" />
              </span>
            )}
          </li>
        ))}
        {replay.status === "running" && <li className="h-28 w-[52px] shrink-0 animate-pulse rounded-lg bg-neutral-100 dark:bg-neutral-800" />}
      </ul>
    </li>
  );
}

function Replay({ run, jobs, locales, job, onError }: { run: RunView; jobs: JobsSnapshot; locales: readonly string[]; job: JobFn; onError: (e: unknown) => void }) {
  const running = isActive(jobs.job);
  const replaying = running && jobs.job?.kind === "replay";
  const rows = [...run.replays].sort((a, b) => locales.indexOf(a.locale) - locales.indexOf(b.locale));
  return (
    <section className={card}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 px-5 py-3.5 dark:border-neutral-800">
        <div>
          <h2 className="text-sm font-semibold">Languages</h2>
          <p className="text-xs text-neutral-500">
            Replays the recorded flow in each language, no model calls, and checks every screen against the one the agent marked.
          </p>
        </div>
        {replaying ? (
          <button
            type="button"
            onClick={() => void job("cancel").catch(onError)}
            disabled={jobs.job?.status !== "running"}
            className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-3 py-1.5 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-60 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            {jobs.job?.status === "cancelling" ? <Spinner className="size-4" /> : null}
            {jobs.job?.status === "cancelling" ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button
            type="button"
            disabled={running || locales.length === 0}
            onClick={() => void job("replay", { locales }).catch(onError)}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm shadow-indigo-600/20 hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PlayIcon className="size-3.5" />
            Replay in {locales.length === 1 ? localeName(locales[0]!) : `${locales.length} languages`}
          </button>
        )}
      </header>
      {rows.length === 0 ? (
        <p className="flex items-center gap-2 px-5 py-6 text-sm text-neutral-500">
          <GlobeIcon className="size-4 shrink-0" /> Not replayed yet. Selected in the Project panel: {locales.map(localeName).join(", ")}.
        </p>
      ) : (
        <ol className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {rows.map((r) => (
            <LocaleRow key={r.locale} runId={run.runId} replay={r} />
          ))}
        </ol>
      )}
    </section>
  );
}

export function Results({
  jobs,
  state,
  locales,
  job,
  onError,
}: {
  jobs: JobsSnapshot;
  state: SessionState;
  locales: readonly string[];
  job: JobFn;
  onError: (e: unknown) => void;
}) {
  const run = jobs.run;
  // While the agent explores, its marks show in the Agent panel; the picks come once it is done.
  if (!run?.summary || run.marks.length === 0) return null;
  const exploring = isActive(jobs.job) && jobs.job?.kind === "explore";
  return (
    <div className="space-y-4 px-5 pb-8">
      <div className="flex items-center gap-2 pt-1 text-xs font-medium uppercase tracking-wide text-neutral-400">
        <SparkleIcon className="size-3.5" /> {run.project.appName}
        <span className="font-normal normal-case tracking-normal">· {new Date(run.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
      </div>
      <Picks run={run} />
      {!exploring && <Replay run={run} jobs={jobs} locales={locales} job={job} onError={onError} />}
      {!exploring && run.compose && run.compose.sets.length > 0 && <ComposePanel run={run} jobs={jobs} state={state} job={job} onError={onError} />}
    </div>
  );
}
