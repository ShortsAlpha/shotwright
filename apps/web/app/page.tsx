import { SCREENSHOT_SETS, SCREENSHOT_SET_IDS } from "@shotwright/core";
import { Logo } from "./_components/icons.tsx";
import { AGENT_COMMAND, PairForm } from "./_components/pair-form.tsx";

export default function HomePage() {
  return (
    <main className="min-h-screen bg-neutral-100/70 dark:bg-neutral-950">
      <div className="mx-auto max-w-xl px-6 py-20 sm:py-28">
        <div className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Logo className="text-indigo-600" /> Shotwright
        </div>
        <h1 className="mt-8 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          App Store screenshots, captured by an agent.
        </h1>
        <p className="mt-4 text-lg text-neutral-600 dark:text-neutral-400">
          An AI agent drives your iOS app in the Simulator and turns real captures into App Store screenshots and videos, for
          every device and every language.
        </p>

        <section className="mt-10 rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <h2 className="font-semibold">Connect your Mac</h2>
          <ol className="mt-4 space-y-5 text-sm">
            <li className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-semibold text-white">1</span>
              <div className="min-w-0 flex-1">
                <p>Run the agent in the Shotwright repo on your Mac (Xcode required):</p>
                <pre className="mt-2 overflow-x-auto rounded-lg bg-neutral-900 px-3 py-2 font-mono text-[13px] text-neutral-100 dark:bg-black">
                  {AGENT_COMMAND}
                </pre>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-semibold text-white">2</span>
              <div className="min-w-0 flex-1">
                <p>Enter the pairing code it prints:</p>
                <PairForm />
              </div>
            </li>
          </ol>
          <p className="mt-2 text-xs text-neutral-500">
            The agent dials out to this site, so your Mac needs no open ports. Your source code never leaves it.
          </p>
        </section>

        <h2 className="mt-12 text-xs font-semibold uppercase tracking-wide text-neutral-500">Screenshot sets</h2>
        <ul className="mt-3 divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
          {SCREENSHOT_SET_IDS.map((id) => {
            const set = SCREENSHOT_SETS[id];
            return (
              <li key={id} className="flex justify-between py-2">
                <span>{set.label}</span>
                <span className="text-neutral-500 tabular-nums">
                  {set.portrait.width} × {set.portrait.height}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </main>
  );
}
