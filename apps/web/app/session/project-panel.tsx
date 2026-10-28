"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SimDevice, XcodeProject } from "@shotwright/core";
import { EXPLORER_MODELS, LOCALES, isActive, localeName, type ExplorerModel, type JobsSnapshot } from "../../lib/jobs/state.ts";
import type { SessionState } from "../../lib/ui-protocol.ts";
import { RefreshIcon, SparkleIcon, Spinner, StopIcon } from "../_components/icons.tsx";
import type { ExploreForm } from "./explore-form.ts";
import type { CallFn, JobFn } from "./use-session.ts";

export const input =
  "w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-sm outline-none transition placeholder:text-neutral-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950 dark:placeholder:text-neutral-600";
const label = "mb-1 block text-xs font-medium text-neutral-500";

/** "/Users/ada/Apps/Renew/Renew.xcodeproj" -> { name: "Renew", where: "~/Apps/Renew" } */
function describeProject(path: string): { name: string; where: string } {
  const parts = path.split("/");
  const file = parts.pop() ?? path;
  return { name: file.replace(/\.(xcodeproj|xcworkspace)$/, ""), where: parts.join("/").replace(/^\/Users\/[^/]+/, "~") || "/" };
}

/** The app's scheme: the one named like the project ("Renew" in Renew.xcodeproj), else the first. */
function preferredScheme(project: XcodeProject | undefined): string {
  if (!project) return "";
  const name = describeProject(project.path).name;
  return project.schemes.find((s) => s === name) ?? project.schemes.find((s) => s.toLowerCase() === name.toLowerCase()) ?? project.schemes[0] ?? "";
}

/** The simulator an exploration runs on: the live one, else Shotwright's iPhone 6.3, else any booted one. */
export function explorationDevice(state: SessionState): SimDevice | undefined {
  const devices = state.devices ?? [];
  return (
    devices.find((d) => d.udid === state.activeUdid) ??
    devices.find((d) => d.setId === "iphone-6.3") ??
    devices.find((d) => d.state === "Booted") ??
    devices[0]
  );
}

export function ProjectPanel({
  state,
  jobs,
  form: ownForm,
  setForm,
  call,
  job,
  onError,
}: {
  state: SessionState;
  jobs: JobsSnapshot;
  form: ExploreForm;
  setForm: (patch: Partial<ExploreForm>) => void;
  call: CallFn;
  job: JobFn;
  onError: (error: unknown) => void;
}) {
  const [projects, setProjects] = useState<XcodeProject[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const requested = useRef(false);
  const connected = state.agent.connected;
  const running = isActive(jobs.job);
  const device = explorationDevice(state);
  // While a job runs, show what it runs with (it may have been started from another tab).
  const run = jobs.run;
  const form: ExploreForm =
    running && run
      ? { ...ownForm, projectPath: run.project.path, scheme: run.project.scheme, launchArgs: run.launchArgs, hint: run.hint, model: run.model, locales: jobs.job?.kind === "explore" ? run.locales : ownForm.locales }
      : ownForm;

  const findProjects = useCallback(
    (root: string) => {
      setLoading(true);
      call("projects.list", root.trim() ? { root: root.trim() } : {})
        .then((list) => {
          setProjects(list);
          // Keep the remembered choice when it is still there; otherwise take the first project.
          const keep = list.find((p) => p.path === form.projectPath);
          const pick = keep ?? list.find((p) => p.schemes.length > 0) ?? list[0];
          if (pick && (!keep || !keep.schemes.includes(form.scheme))) setForm({ projectPath: pick.path, scheme: preferredScheme(pick) });
        })
        .catch(onError)
        .finally(() => setLoading(false));
    },
    [call, form.projectPath, onError, setForm],
  );

  useEffect(() => {
    if (connected && !requested.current) {
      requested.current = true;
      findProjects(form.root);
    }
  }, [connected, findProjects, form.root]);

  const project = projects?.find((p) => p.path === form.projectPath);
  const schemes = project?.schemes ?? (form.scheme ? [form.scheme] : []);
  const canExplore = connected && !running && Boolean(form.projectPath && form.scheme && device && form.locales.length > 0);

  const explore = () => {
    if (!device) return;
    setStarting(true);
    job("explore", {
      projectPath: form.projectPath,
      scheme: form.scheme,
      udid: device.udid,
      launchArgs: form.launchArgs,
      hint: form.hint,
      locales: form.locales,
      model: form.model,
    })
      .catch(onError)
      .finally(() => setStarting(false));
  };

  const toggleLocale = (code: string) => {
    const has = form.locales.includes(code);
    if (has && form.locales.length === 1) return;
    setForm({ locales: has ? form.locales.filter((l) => l !== code) : [...form.locales, code] });
  };

  return (
    <section className="flex flex-col rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
        <h2 className="text-sm font-semibold">Project</h2>
        {device && (
          <span className="truncate pl-3 text-xs text-neutral-500" title="Pick another simulator below with Live view">
            {device.name}
          </span>
        )}
      </header>

      <form
        className="space-y-3 px-4 py-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (canExplore) explore();
        }}
      >
        <div>
          <label className={label} htmlFor="project-root">
            Folder on your Mac
          </label>
          <div className="flex gap-1.5">
            <input
              id="project-root"
              className={`${input} font-mono text-xs`}
              placeholder="Where the agent runs"
              value={form.root}
              disabled={running}
              onChange={(e) => setForm({ root: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  findProjects(form.root);
                }
              }}
            />
            <button
              type="button"
              onClick={() => findProjects(form.root)}
              disabled={!connected || loading || running}
              className="shrink-0 rounded-lg border border-neutral-200 px-2 text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-white"
              title="Find Xcode projects in this folder"
              aria-label="Find projects"
            >
              {loading ? <Spinner className="size-3.5" /> : <RefreshIcon className="size-3.5" />}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-2">
          <div>
            <label className={label} htmlFor="project">
              Project
            </label>
            <select
              id="project"
              className={input}
              value={form.projectPath}
              disabled={running || !projects?.length}
              title={form.projectPath}
              onChange={(e) => {
                const next = projects?.find((p) => p.path === e.target.value);
                setForm({ projectPath: e.target.value, scheme: preferredScheme(next) });
              }}
            >
              {!projects?.length && !form.projectPath && <option value="">{loading ? "Searching…" : projects ? "No projects found" : "—"}</option>}
              {form.projectPath && !projects?.some((p) => p.path === form.projectPath) && (
                <option value={form.projectPath}>
                  {describeProject(form.projectPath).name} — {describeProject(form.projectPath).where}
                </option>
              )}
              {projects?.map((p) => {
                const d = describeProject(p.path);
                return (
                  <option key={p.path} value={p.path}>
                    {d.name} — {d.where}
                  </option>
                );
              })}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="scheme">
              Scheme
            </label>
            <select id="scheme" className={input} value={form.scheme} disabled={running || schemes.length === 0} onChange={(e) => setForm({ scheme: e.target.value })}>
              {schemes.length === 0 && <option value="">—</option>}
              {schemes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className={label} htmlFor="launch-args">
            Launch arguments
          </label>
          <input
            id="launch-args"
            className={`${input} font-mono text-xs`}
            placeholder="-ShotwrightDemo"
            value={form.launchArgs}
            disabled={running}
            spellCheck={false}
            onChange={(e) => setForm({ launchArgs: e.target.value })}
          />
          <p className="mt-1 text-[11px] leading-snug text-neutral-500">
            Load demo data so every screen has content. <code className="font-mono">{"{region}"}</code> becomes US, DE, JP… per language.
          </p>
        </div>

        <div>
          <label className={label} htmlFor="hint">
            What the app does <span className="font-normal text-neutral-400">(optional)</span>
          </label>
          <input
            id="hint"
            className={input}
            placeholder="A subscription tracker"
            value={form.hint}
            maxLength={300}
            disabled={running}
            onChange={(e) => setForm({ hint: e.target.value })}
          />
        </div>

        <div>
          <span className={label}>Languages</span>
          <div className="flex flex-wrap gap-1.5">
            {LOCALES.map((l) => {
              const on = form.locales.includes(l.code);
              return (
                <button
                  key={l.code}
                  type="button"
                  disabled={running}
                  onClick={() => toggleLocale(l.code)}
                  aria-pressed={on}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium transition disabled:opacity-60 ${
                    on
                      ? "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-300"
                      : "border-neutral-200 text-neutral-500 hover:border-neutral-300 hover:text-neutral-800 dark:border-neutral-700 dark:hover:text-neutral-200"
                  }`}
                >
                  {l.name}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11px] text-neutral-500">
            Explores in {localeName(form.locales[0] ?? "en")}, then replays in {form.locales.length === 1 ? "it" : `all ${form.locales.length}`}.
          </p>
        </div>

        <div className="flex min-w-0 gap-2 pt-1">
          <select
            aria-label="Explorer model"
            title="The model that explores"
            className="w-[8.5rem] shrink-0 rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950"
            value={form.model}
            disabled={running}
            onChange={(e) => setForm({ model: e.target.value as ExplorerModel })}
          >
            {EXPLORER_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {running ? (
            <button
              type="button"
              onClick={() => void job("cancel").catch(onError)}
              disabled={jobs.job?.status !== "running"}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-60 dark:border-red-900 dark:bg-transparent dark:text-red-400 dark:hover:bg-red-950/40"
            >
              {jobs.job?.status === "cancelling" ? <Spinner className="size-4" /> : <StopIcon className="size-4" />}
              {jobs.job?.status === "cancelling" ? "Stopping…" : "Stop"}
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canExplore || starting}
              className="inline-flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm shadow-indigo-600/20 transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {starting ? <Spinner className="size-4" /> : <SparkleIcon className="size-4" />}
              Explore
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
