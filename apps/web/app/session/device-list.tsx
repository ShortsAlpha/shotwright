"use client";

import { useState } from "react";
import { SCREENSHOT_SETS, type SimDevice } from "@shotwright/core";
import type { SessionState } from "../../lib/ui-protocol.ts";
import { PhoneIcon, PlayIcon, PowerIcon, RefreshIcon, Spinner } from "../_components/icons.tsx";

export interface DeviceActions {
  readonly refresh: () => void;
  readonly boot: (udid: string) => void;
  readonly shutdown: (udid: string) => void;
  readonly connect: (udid: string) => void;
}

const button =
  "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
const primary = `${button} bg-indigo-600 text-white hover:bg-indigo-500`;
const secondary = `${button} border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800`;

function StateDot({ state, busy }: { state: string; busy: boolean }) {
  const color = busy ? "bg-amber-400 animate-pulse" : state === "Booted" ? "bg-emerald-500" : "bg-neutral-300 dark:bg-neutral-600";
  return <span className={`inline-block size-2 rounded-full ${color}`} />;
}

export function DeviceList({ state, actions }: { state: SessionState; actions: DeviceActions }) {
  const [showAll, setShowAll] = useState(false);
  const devices = state.devices ?? [];
  const featured = devices.filter((d) => d.setId !== undefined || d.state !== "Shutdown" || d.udid === state.activeUdid);
  const visible = showAll ? devices : featured;
  const hidden = devices.length - featured.length;
  const listing = state.busy.some((b) => b.method === "devices.list");
  const busyFor = (udid: string) => state.busy.find((b) => b.udid === udid)?.method;
  const offline = !state.agent.connected;

  return (
    <section className="flex min-h-0 flex-col rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
        <h2 className="text-sm font-semibold">Simulators</h2>
        <button
          type="button"
          onClick={actions.refresh}
          disabled={offline || listing}
          className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-40 dark:hover:bg-neutral-800 dark:hover:text-white"
          title="Refresh"
          aria-label="Refresh simulators"
        >
          {listing ? <Spinner /> : <RefreshIcon />}
        </button>
      </header>

      {state.devices === null ? (
        <p className="px-4 py-6 text-sm text-neutral-500">{offline ? "Waiting for the Mac agent…" : "Loading simulators…"}</p>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-neutral-100 overflow-y-auto dark:divide-neutral-800">
          {visible.map((device) => (
            <DeviceRow
              key={device.udid}
              device={device}
              active={device.udid === state.activeUdid}
              busy={busyFor(device.udid)}
              disabled={offline}
              actions={actions}
            />
          ))}
          {visible.length === 0 && <li className="px-4 py-6 text-sm text-neutral-500">No iOS simulators found.</li>}
        </ul>
      )}

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="border-t border-neutral-100 px-4 py-2.5 text-left text-xs font-medium text-neutral-500 hover:text-neutral-900 dark:border-neutral-800 dark:hover:text-white"
        >
          {showAll ? "Show Shotwright and booted only" : `Show ${hidden} more simulator${hidden === 1 ? "" : "s"}`}
        </button>
      )}
    </section>
  );
}

const BUSY_LABEL: Record<string, string> = {
  "device.boot": "Booting…",
  "device.shutdown": "Shutting down…",
  "runner.ensure": "Starting runner…",
  "app.build": "Building…",
  "app.install": "Installing…",
};

function DeviceRow({
  device,
  active,
  busy,
  disabled,
  actions,
}: {
  device: SimDevice;
  active: boolean;
  busy: string | undefined;
  disabled: boolean;
  actions: DeviceActions;
}) {
  const booted = device.state === "Booted";
  const set = device.setId ? SCREENSHOT_SETS[device.setId] : undefined;
  return (
    <li className={`px-4 py-3 ${active ? "bg-indigo-50/60 dark:bg-indigo-950/30" : ""}`}>
      <div className="flex items-start gap-3">
        <PhoneIcon className="mt-0.5 shrink-0 text-neutral-400" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-medium">{device.name}</span>
            {set && (
              <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-300">
                {set.label}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-neutral-500">
            <StateDot state={device.state} busy={busy !== undefined} />
            <span>{busy ? BUSY_LABEL[busy] ?? "Working…" : device.state}</span>
            <span aria-hidden>·</span>
            <span>{device.runtime}</span>
            {active && <span className="font-medium text-indigo-600 dark:text-indigo-400">· Live</span>}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button
              type="button"
              className={primary}
              disabled={disabled || busy !== undefined}
              onClick={() => actions.connect(device.udid)}
              title={booted ? "Start the runner and show the screen" : "Boot, start the runner and show the screen"}
            >
              {busy === "runner.ensure" ? <Spinner className="size-3.5" /> : <PlayIcon className="size-3.5" />}
              {active ? "Reconnect" : "Live view"}
            </button>
            {booted ? (
              <button type="button" className={secondary} disabled={disabled || busy !== undefined} onClick={() => actions.shutdown(device.udid)}>
                {busy === "device.shutdown" ? <Spinner className="size-3.5" /> : <PowerIcon className="size-3.5" />}
                Shut down
              </button>
            ) : (
              <button type="button" className={secondary} disabled={disabled || busy !== undefined} onClick={() => actions.boot(device.udid)}>
                {busy === "device.boot" ? <Spinner className="size-3.5" /> : <PowerIcon className="size-3.5" />}
                Boot
              </button>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
