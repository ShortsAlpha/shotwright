"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionState } from "../../lib/ui-protocol.ts";
import { Logo } from "../_components/icons.tsx";
import { AGENT_COMMAND } from "../_components/pair-form.tsx";
import { DeviceList, type DeviceActions } from "./device-list.tsx";
import { LiveView } from "./live-view.tsx";
import { LogPanel } from "./log-panel.tsx";
import { useSession, type SocketStatus } from "./use-session.ts";

function AgentStatus({ status, state }: { status: SocketStatus; state: SessionState | null }) {
  let dot = "bg-neutral-300";
  let label = "Connecting…";
  let detail: string | null = null;
  if (status === "reconnecting") {
    dot = "bg-amber-400 animate-pulse";
    label = "Reconnecting to the server…";
  } else if (state?.agent.connected) {
    dot = "bg-emerald-500";
    label = "Mac connected";
    detail = [state.agent.xcode && `Xcode ${state.agent.xcode}`, state.agent.macos && `macOS ${state.agent.macos}`]
      .filter(Boolean)
      .join(" · ");
  } else if (state) {
    dot = "bg-amber-400 animate-pulse";
    label = "Mac agent offline";
  }
  return (
    <div className="flex items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-xs dark:border-neutral-800 dark:bg-neutral-900">
      <span className={`size-2 rounded-full ${dot}`} />
      <span className="font-medium">{label}</span>
      {detail && <span className="hidden text-neutral-500 sm:inline">{detail}</span>}
    </div>
  );
}

export function SessionView() {
  const session = useSession();
  const { status, state, logs, call, clearLogs } = session;
  const [error, setError] = useState<string | null>(null);
  const requestedDevices = useRef(false);

  const onError = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), []);

  // Load the simulator list once the agent is there.
  useEffect(() => {
    if (state?.agent.connected && state.devices === null && !requestedDevices.current) {
      requestedDevices.current = true;
      call("devices.list", {}).catch(onError);
    }
  }, [state, call, onError]);

  const actions = useMemo<DeviceActions>(
    () => ({
      refresh: () => void call("devices.list", {}).catch(onError),
      boot: (udid) => void call("device.boot", { udid }).catch(onError),
      shutdown: (udid) => void call("device.shutdown", { udid }).catch(onError),
      connect: (udid) => {
        setError(null);
        void call("runner.ensure", { udid })
          .then(() => call("stream.start", { fps: 4, maxWidth: 720 }))
          .catch(onError);
      },
    }),
    [call, onError],
  );

  if (status === "ended") {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
        <Logo className="text-indigo-600" />
        <h1 className="mt-4 text-xl font-semibold">This session has ended</h1>
        <p className="mt-2 text-sm text-neutral-500">
          Sessions live in the server&apos;s memory, so a restart ends them. Run <code className="font-mono">{AGENT_COMMAND}</code> and pair
          with the new code.
        </p>
        <Link href="/" className="mt-6 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
          Pair again
        </Link>
      </main>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-neutral-100/70 dark:bg-neutral-950">
      <header className="flex items-center justify-between gap-4 border-b border-neutral-200 bg-white/80 px-5 py-3 backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/80">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <Logo className="text-indigo-600" /> Shotwright
        </Link>
        <AgentStatus status={status} state={state} />
      </header>

      {error && (
        <div className="mx-5 mt-4 flex items-start justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" onClick={() => setError(null)} className="shrink-0 font-medium hover:underline">
            Dismiss
          </button>
        </div>
      )}

      {state && !state.agent.connected && status === "open" && (
        <div className="mx-5 mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          The agent on your Mac is not connected. It reconnects on its own after a network hiccup; if you stopped it, run{" "}
          <code className="font-mono">{AGENT_COMMAND}</code> and <Link href="/" className="font-medium underline">pair again</Link>.
        </div>
      )}

      {state ? (
        <main className="grid flex-1 gap-4 p-5 lg:h-[calc(100vh-57px)] lg:grid-cols-[300px_minmax(0,1fr)_360px] lg:overflow-hidden">
          <DeviceList state={state} actions={actions} />
          <LiveView session={session} state={state} onError={onError} />
          <LogPanel logs={logs} onClear={clearLogs} />
        </main>
      ) : (
        <main className="flex flex-1 items-center justify-center text-sm text-neutral-500">Connecting to your session…</main>
      )}
    </div>
  );
}
