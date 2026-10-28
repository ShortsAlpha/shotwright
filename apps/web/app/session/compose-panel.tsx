"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FRAMES,
  TEMPLATES,
  captionIssues,
  captionLimit,
  effectiveTheme,
  plainCaption,
  renderCounts,
  type CaptionView,
  type ComposeSettings,
  type ComposeView,
  type RenderView,
  type ThemeSettings,
} from "../../lib/compose/state.ts";
import { artifactUrl, isActive, localeName, type JobsSnapshot, type RunView } from "../../lib/jobs/state.ts";
import type { SessionState } from "../../lib/ui-protocol.ts";
import { AlertIcon, DownloadIcon, PaletteIcon, RefreshIcon, SparkleIcon, Spinner, StopIcon } from "../_components/icons.tsx";
import type { JobFn } from "./use-session.ts";

const card = "rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900";
const label = "mb-1.5 block text-xs font-medium text-neutral-500";
const segment = (on: boolean) =>
  `flex-1 rounded-md px-2 py-1 text-xs font-medium transition ${
    on ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white" : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
  }`;

/** Calls `fn` once `ms` have passed without another call; flushes on unmount. */
function useDebounced<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback(
    (...args: A) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => latest.current(...args), ms);
    },
    [ms],
  );
}

function ColorField({ name, value, onChange }: { name: string; value: string; onChange: (hex: string) => void }) {
  return (
    <label title={`${name}: ${value}`} className="flex min-w-0 items-center gap-2 rounded-lg border border-neutral-200 px-2 py-1.5 text-xs dark:border-neutral-700">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="size-5 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" aria-label={name} />
      <span className="min-w-0 flex-1 truncate text-neutral-600 dark:text-neutral-300">{name}</span>
    </label>
  );
}

function TemplatePicker({
  settings,
  previews,
  onPick,
  disabled,
  aspect,
}: {
  settings: ComposeSettings;
  previews: Record<string, string>;
  onPick: (id: ComposeSettings["template"]) => void;
  disabled: boolean;
  /** CSS aspect-ratio of the set ("1206 / 2622"). */
  aspect: string;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {TEMPLATES.map((t) => {
        const on = settings.template === t.id;
        const src = previews[t.id];
        return (
          <button
            key={t.id}
            type="button"
            title={t.hint}
            disabled={disabled}
            onClick={() => onPick(t.id)}
            aria-pressed={on}
            className={`group min-w-0 rounded-xl border p-1.5 text-left transition disabled:opacity-60 ${
              on ? "border-indigo-400 ring-2 ring-indigo-500/25 dark:border-indigo-500" : "border-neutral-200 hover:border-neutral-300 dark:border-neutral-700"
            }`}
          >
            <div className="overflow-hidden rounded-lg bg-neutral-100 dark:bg-neutral-800" style={{ aspectRatio: aspect }}>
              {src ? <img src={src} alt={`${t.label} preview`} className="h-full w-full object-cover" /> : <div className="h-full w-full animate-pulse" />}
            </div>
            <p className={`mt-1.5 truncate text-[11px] font-semibold ${on ? "text-indigo-700 dark:text-indigo-300" : ""}`}>{t.label}</p>
          </button>
        );
      })}
    </div>
  );
}

function ThemeEditor({
  runId,
  view,
  theme,
  onTheme,
  disabled,
}: {
  runId: string;
  view: ComposeView;
  theme: ThemeSettings;
  onTheme: (theme: ThemeSettings | null) => void;
  disabled: boolean;
}) {
  const s = view.suggested;
  const custom = view.settings.theme !== null;
  const set = (patch: Partial<ThemeSettings>) => onTheme({ ...theme, ...patch });
  const setBg = (patch: Partial<ThemeSettings["background"]>) => onTheme({ ...theme, background: { ...theme.background, ...patch } });
  const source =
    s.source === "icon" ? "From your app icon" : s.checked ? "Default theme: no PNG app icon in the project" : "Default theme; the app icon is read when you compose";
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-2.5">
      <div className="flex items-center gap-2.5">
        {s.icon ? (
          <img src={artifactUrl(runId, s.icon, "icon")} alt="App icon" className="size-9 shrink-0 rounded-[22%] border border-neutral-200 dark:border-neutral-700" />
        ) : (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[22%] bg-neutral-100 text-neutral-400 dark:bg-neutral-800">
            <PaletteIcon />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{custom ? "Your colors" : source}</p>
          {s.colors.length > 0 && (
            <div className="mt-1 flex gap-1">
              {s.colors.map((c) => (
                <button
                  key={c}
                  type="button"
                  title={`Use ${c} as the accent`}
                  onClick={() => set({ accent: c })}
                  className="size-3.5 rounded-full border border-black/10 dark:border-white/20"
                  style={{ background: c }}
                />
              ))}
            </div>
          )}
        </div>
        {custom && (
          <button type="button" onClick={() => onTheme(null)} className="shrink-0 text-[11px] font-medium text-indigo-600 hover:underline dark:text-indigo-400">
            Reset
          </button>
        )}
      </div>
      <div className="flex gap-1 rounded-lg bg-neutral-100 p-0.5 dark:bg-neutral-800">
        <button type="button" className={segment(!custom)} onClick={() => onTheme(null)}>
          {s.source === "icon" ? "Icon" : "Default"}
        </button>
        <button type="button" className={segment(custom && JSON.stringify(theme) === JSON.stringify(s.light))} onClick={() => onTheme(s.light)}>
          Light
        </button>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <ColorField name="Top" value={theme.background.from} onChange={(from) => setBg({ from })} />
        <ColorField name="Bottom" value={theme.background.to} onChange={(to) => setBg({ to })} />
        <ColorField name="Caption" value={theme.captionColor} onChange={(captionColor) => set({ captionColor })} />
        <ColorField name="Accent" value={theme.accent} onChange={(accent) => set({ accent })} />
      </div>
      <div>
        <span className={label}>Device</span>
        <div className="flex gap-1 rounded-lg bg-neutral-100 p-0.5 dark:bg-neutral-800">
          {(["dark", "light"] as const).map((c) => (
            <button key={c} type="button" className={segment(theme.deviceColor === c)} onClick={() => set({ deviceColor: c })}>
              {c === "dark" ? "Graphite" : "Silver"}
            </button>
          ))}
        </div>
      </div>
    </fieldset>
  );
}

/** One caption, edited in place: Enter saves (and re-renders), Escape reverts. */
function CaptionEditor({
  caption,
  locale,
  appName,
  onSave,
}: {
  caption: CaptionView | undefined;
  locale: string;
  appName: string;
  onSave: (text: string) => Promise<unknown>;
}) {
  const saved = caption?.text ?? "";
  const [text, setText] = useState(saved);
  const [saving, setSaving] = useState(false);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(saved);
  }, [saved]);
  const limit = captionLimit(locale);
  const length = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(plainCaption(text))].length;
  const issues = text === saved ? (caption?.issues ?? []) : captionIssues(text, locale, appName);
  const commit = () => {
    editing.current = false;
    const next = text.trim();
    if (next === saved || saving) return;
    setSaving(true);
    onSave(next).finally(() => setSaving(false));
  };
  const sourceLabel: Record<string, string> = { muse: "Muse", judge: "Judge", edited: "Edited", fallback: "English" };
  return (
    <div className="space-y-1">
      <textarea
        value={text}
        dir="auto"
        rows={2}
        spellCheck
        lang={locale}
        aria-label={`Caption (${localeName(locale)})`}
        onFocus={() => (editing.current = true)}
        onChange={(e) => setText(e.target.value.replace(/\n/g, " "))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            editing.current = false;
            setText(saved);
            e.currentTarget.blur();
          }
        }}
        className={`block w-full resize-none rounded-lg border bg-white px-2 py-1.5 text-[13px] font-semibold leading-snug outline-none transition focus:ring-2 dark:bg-neutral-950 ${
          issues.length
            ? "border-amber-300 focus:border-amber-400 focus:ring-amber-500/20 dark:border-amber-700"
            : "border-neutral-200 focus:border-indigo-400 focus:ring-indigo-500/20 dark:border-neutral-700"
        }`}
      />
      <div className="flex items-center gap-1.5 text-[10px] text-neutral-400">
        {saving ? (
          <span className="inline-flex items-center gap-1 text-indigo-500">
            <Spinner className="size-2.5" /> Saving
          </span>
        ) : (
          caption && (
            <span className={`rounded px-1 font-semibold uppercase tracking-wide ${caption.source === "edited" ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300" : "bg-neutral-100 dark:bg-neutral-800"}`}>
              {sourceLabel[caption.source]}
            </span>
          )
        )}
        {caption?.source === "edited" && caption.original && !saving && (
          <button type="button" className="font-medium text-neutral-500 hover:text-indigo-600" title={`Back to “${caption.original}”`} onClick={() => void onSave("")}>
            Reset
          </button>
        )}
        <span className={`ml-auto tabular-nums ${length > limit.chars ? "font-semibold text-amber-600" : ""}`}>
          {length}/{limit.chars}
        </span>
      </div>
      {issues.length > 0 && (
        <p className="flex items-start gap-1 text-[10px] leading-snug text-amber-700 dark:text-amber-400">
          <AlertIcon className="mt-px size-2.5 shrink-0" /> {issues.join(" · ")}
        </p>
      )}
    </div>
  );
}

function Shot({ runId, render, aspect, children }: { runId: string; render: RenderView; aspect: string; children: ReactNode }) {
  const busy = render.status === "queued" || render.status === "rendering";
  const scale = render.captionScale !== undefined && render.captionScale < 0.75 ? render.captionScale : undefined;
  return (
    <li className="min-w-0">
      <div className="relative">
        {render.thumb ? (
          <a href={artifactUrl(runId, render.image ?? render.thumb, render.version)} target="_blank" rel="noreferrer" className="block">
            <img
              src={artifactUrl(runId, render.thumb, render.version)}
              alt={render.screen}
              style={{ aspectRatio: aspect }}
              className={`w-full rounded-xl border border-neutral-200 bg-neutral-100 object-cover shadow-sm transition dark:border-neutral-700 dark:bg-neutral-800 ${
                busy || render.status === "stale" ? "opacity-55" : ""
              }`}
            />
          </a>
        ) : (
          <div style={{ aspectRatio: aspect }} className="flex w-full items-center justify-center rounded-xl border border-dashed border-neutral-300 bg-neutral-50 text-[10px] text-neutral-400 dark:border-neutral-700 dark:bg-neutral-900">
            {busy ? <Spinner className="size-4" /> : render.status === "failed" ? "Failed" : "Not rendered"}
          </div>
        )}
        <span className={`absolute left-1.5 top-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-white ${render.position <= 3 ? "bg-indigo-600" : "bg-neutral-900/70"}`}>
          {render.position}
        </span>
        {busy && render.thumb && (
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="rounded-full bg-white/90 p-1.5 shadow dark:bg-neutral-900/90">
              <Spinner className="size-4 text-indigo-600" />
            </span>
          </span>
        )}
        {render.status === "stale" && (
          <span className="absolute right-1.5 top-1.5 rounded-full bg-amber-400 px-1.5 py-0.5 text-[9px] font-bold uppercase text-white" title="Changed since it was rendered">
            Outdated
          </span>
        )}
        {render.status === "failed" && (
          <span className="absolute right-1.5 top-1.5 rounded-full bg-red-500 p-0.5 text-white" title={render.error}>
            <AlertIcon className="size-3" />
          </span>
        )}
        {scale !== undefined && render.status === "done" && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-amber-400/95 px-1 text-[9px] font-semibold text-white" title="The caption was shrunk to fit; a shorter one reads better">
            {Math.round(scale * 100)}%
          </span>
        )}
      </div>
      <div className="mt-2">{children}</div>
    </li>
  );
}

export function ComposePanel({
  run,
  jobs,
  state,
  job,
  onError,
}: {
  run: RunView;
  jobs: JobsSnapshot;
  state: SessionState;
  job: JobFn;
  onError: (e: unknown) => void;
}) {
  const view = run.compose!;
  const running = isActive(jobs.job);
  const composing = running && jobs.job?.kind === "compose";
  const otherJob = running && !composing;
  const [setId, setSetId] = useState(view.sets[0]?.id);
  const set = view.sets.find((s) => s.id === setId) ?? view.sets[0]!;
  const [locale, setLocale] = useState(set.locales[0]!);
  const activeLocale = set.locales.includes(locale) ? locale : set.locales[0]!;
  // Settings as the user is editing them; the server's copy arrives with the next compose event.
  const [draft, setDraft] = useState<ComposeSettings>(view.settings);
  const pendingSettings = useRef(false);
  useEffect(() => {
    if (!pendingSettings.current) setDraft(view.settings);
  }, [view.settings]);
  const draftView = useMemo(() => ({ ...view, settings: draft }), [view, draft]);
  const theme = effectiveTheme(draftView);
  const counts = renderCounts(view);
  const missing = Object.values(view.renders).some((l) => Object.values(l).some((list) => list.some((r) => !r.image)));
  const stale = Object.values(view.renders).reduce((n, l) => n + Object.values(l).reduce((m, list) => m + list.filter((r) => r.status === "stale" || r.status === "missing" || r.status === "failed").length, 0), 0);
  const captionsNeeded = set.locales.some((l) => view.screens.some((s) => {
    const c = view.captions.byLocale[l]?.[s];
    return !c || c.source === "fallback" || (c.source === "judge" && l === "en");
  }));

  // --- Template previews (first screen, current locale) ---------------------------------
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const previewSeq = useRef(0);
  const requestPreviews = useCallback(
    (settings: ComposeSettings, forLocale: string) => {
      const seq = ++previewSeq.current;
      job("preview", { settings, locale: forLocale })
        .then((value) => {
          if (seq === previewSeq.current) setPreviews(value as Record<string, string>);
        })
        .catch(() => undefined);
    },
    [job],
  );
  const debouncedPreviews = useDebounced(requestPreviews, 250);
  const firstCaption = view.captions.byLocale[activeLocale]?.[view.screens[0] ?? ""]?.text;
  useEffect(() => {
    debouncedPreviews(draft, activeLocale);
  }, [draft.frame, draft.theme, activeLocale, firstCaption, view.suggested.source, debouncedPreviews]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Settings -> compose job ------------------------------------------------------------
  const compose = useCallback(
    (params: Record<string, unknown> = {}) => {
      job("compose", params)
        .catch(onError)
        .finally(() => (pendingSettings.current = false));
    },
    [job, onError],
  );
  const debouncedCompose = useDebounced((settings: ComposeSettings) => compose({ settings }), 700);
  const change = (patch: Partial<ComposeSettings>, debounce = false) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (otherJob) return; // Saved with the next compose.
    pendingSettings.current = true;
    if (debounce) debouncedCompose(next);
    else compose({ settings: next });
  };

  const saveCaption = (screen: string) => (text: string) => job("caption", { locale: activeLocale, screen, text }).catch(onError);

  const captionQuota = state.quota.captions;
  const captionsLeft = Math.max(0, Math.min(captionQuota.limit - captionQuota.used, captionQuota.dailyLimit - captionQuota.dailyUsed));
  const progress = composing ? jobs.job?.progress : undefined;
  const ready = !composing && counts.total > 0 && !missing && counts.failed === 0;

  let action: string;
  if (counts.done === 0) action = `Compose ${counts.total} screenshots`;
  else if (stale > 0) action = `Update ${stale} screenshot${stale === 1 ? "" : "s"}`;
  else if (captionsNeeded) action = "Write captions";
  else action = "Up to date";

  const list = view.renders[set.id]?.[activeLocale] ?? [];
  const aspect = `${set.width} / ${set.height}`;

  return (
    <section className={card}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 px-5 py-3.5 dark:border-neutral-800">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Screenshots</h2>
          <p className="text-xs text-neutral-500">
            {view.captions.model
              ? `Captions written per market by ${view.captions.model.replace(/^meta-models\//, "")}${view.captions.ms ? ` in ${(view.captions.ms / 1000).toFixed(0)} s` : ""}`
              : "Captions are written per market by Muse Spark Open when you compose"}
            {" · "}
            {set.label} {set.width}×{set.height} · {counts.done}/{counts.total} rendered
          </p>
        </div>
        <div className="flex items-center gap-2">
          {composing ? (
            <button
              type="button"
              onClick={() => void job("cancel").catch(onError)}
              disabled={jobs.job?.status !== "running"}
              className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-3 py-1.5 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-60 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              {jobs.job?.status === "cancelling" ? <Spinner className="size-4" /> : <StopIcon className="size-3.5" />}
              {jobs.job?.status === "cancelling" ? "Stopping…" : "Stop"}
            </button>
          ) : (
            <button
              type="button"
              disabled={otherJob || (stale === 0 && !captionsNeeded)}
              onClick={() => compose({ settings: draft })}
              title={otherJob ? "Wait for the running job" : undefined}
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                ready && stale === 0
                  ? "border border-neutral-200 text-neutral-500 dark:border-neutral-700"
                  : "bg-indigo-600 text-white shadow-sm shadow-indigo-600/20 hover:bg-indigo-500"
              }`}
            >
              <SparkleIcon className="size-3.5" />
              {action}
            </button>
          )}
          <a
            href={ready ? `/api/runs/${encodeURIComponent(run.runId)}/zip` : undefined}
            download
            aria-disabled={!ready}
            onClick={(e) => {
              if (!ready) e.preventDefault();
            }}
            title={ready ? `${view.appName}-screenshots.zip: fastlane deliver layout and a README` : "Compose the screenshots first"}
            className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
              ready ? "bg-emerald-600 text-white shadow-sm shadow-emerald-600/20 hover:bg-emerald-500" : "cursor-not-allowed bg-neutral-100 text-neutral-400 dark:bg-neutral-800"
            }`}
          >
            <DownloadIcon className="size-4" />
            Download zip
          </a>
        </div>
        {composing && (
          <div className="w-full">
            <div className="flex items-center justify-between text-[11px] text-neutral-500">
              <span className="inline-flex items-center gap-1.5">
                <Spinner className="size-3" /> {jobs.job?.phaseLabel ?? "Starting"}
              </span>
              {progress && progress.total > 0 && (
                <span className="tabular-nums">
                  {progress.done} of {progress.total}
                </span>
              )}
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
              <div
                className="h-full rounded-full bg-indigo-500 transition-all duration-300"
                style={{ width: `${progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 4}%` }}
              />
            </div>
          </div>
        )}
      </header>

      <div className="grid gap-0 lg:grid-cols-[296px_minmax(0,1fr)]">
        <aside className="space-y-5 border-b border-neutral-100 px-5 py-4 lg:border-b-0 lg:border-r dark:border-neutral-800">
          <div>
            <span className={label}>Template</span>
            <TemplatePicker settings={draft} previews={previews} disabled={otherJob} aspect={aspect} onPick={(template) => change({ template })} />
          </div>
          <div>
            <span className={label}>Theme</span>
            <ThemeEditor runId={run.runId} view={draftView} theme={theme} disabled={otherJob} onTheme={(t) => change({ theme: t }, true)} />
          </div>
          <div>
            <span className={label}>Frame</span>
            <div className="flex gap-1 rounded-lg bg-neutral-100 p-0.5 dark:bg-neutral-800">
              {FRAMES.map((f) => (
                <button key={f.id} type="button" title={f.hint} disabled={otherJob} className={segment(draft.frame === f.id)} onClick={() => change({ frame: f.id })}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          {otherJob && <p className="text-[11px] text-neutral-500">A {jobs.job?.kind} is running; changes apply when you compose after it.</p>}
        </aside>

        <div className="min-w-0 px-5 py-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1" role="tablist">
              {set.locales.map((l) => {
                const shots = view.renders[set.id]?.[l] ?? [];
                const done = shots.filter((r) => r.status === "done").length;
                const warn = view.screens.some((s) => view.captions.byLocale[l]?.[s]?.issues?.length);
                return (
                  <button
                    key={l}
                    type="button"
                    role="tab"
                    aria-selected={l === activeLocale}
                    onClick={() => setLocale(l)}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ${
                      l === activeLocale
                        ? "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-300"
                        : "border-neutral-200 text-neutral-500 hover:text-neutral-800 dark:border-neutral-700 dark:hover:text-neutral-200"
                    }`}
                  >
                    {localeName(l)}
                    <span className="tabular-nums text-[10px] opacity-70">
                      {done}/{shots.length}
                    </span>
                    {warn && <span className="size-1.5 rounded-full bg-amber-400" title="Some captions break the rules" />}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              {view.sets.length > 1 && (
                <div className="flex gap-1 rounded-lg bg-neutral-100 p-0.5 dark:bg-neutral-800">
                  {view.sets.map((s) => (
                    <button key={s.id} type="button" className={segment(s.id === set.id)} onClick={() => setSetId(s.id)}>
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                disabled={running || captionsLeft === 0}
                onClick={() => compose({ settings: draft, regenerateCaptions: true })}
                title={
                  captionsLeft === 0
                    ? "No caption runs left for now"
                    : `Muse rewrites every caption you have not edited, in all languages (${captionsLeft} run${captionsLeft === 1 ? "" : "s"} left this hour)`
                }
                className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                <RefreshIcon className="size-3" /> Rewrite captions
              </button>
            </div>
          </div>
          <ol className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
            {list.map((r) => (
              <Shot key={r.screen} runId={run.runId} render={r} aspect={aspect}>
                <CaptionEditor caption={view.captions.byLocale[activeLocale]?.[r.screen]} locale={activeLocale} appName={view.appName} onSave={saveCaption(r.screen)} />
              </Shot>
            ))}
          </ol>
          <p className="mt-3 text-[11px] text-neutral-500">
            Press Enter to save a caption; that screenshot re-renders. Wrap words in *asterisks* for the accent color.
          </p>
        </div>
      </div>
    </section>
  );
}
