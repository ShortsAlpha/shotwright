import { SCREENSHOT_SETS, SCREENSHOT_SET_IDS } from "@shotwright/core";

export default function HomePage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="text-4xl font-semibold tracking-tight">Shotwright</h1>
      <p className="mt-4 text-lg text-neutral-600 dark:text-neutral-400">
        An AI agent drives your iOS app in the Simulator and turns real captures into App Store
        screenshots and videos, for every device and every language.
      </p>

      <h2 className="mt-12 text-sm font-medium uppercase tracking-wide text-neutral-500">
        Screenshot sets
      </h2>
      <ul className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
        {SCREENSHOT_SET_IDS.map((id) => {
          const set = SCREENSHOT_SETS[id];
          return (
            <li key={id} className="flex justify-between py-2 text-sm">
              <span>{set.label}</span>
              <span className="tabular-nums text-neutral-500">
                {set.portrait.width} × {set.portrait.height}
              </span>
            </li>
          );
        })}
      </ul>

      <p className="mt-12 text-sm text-neutral-500">Dashboard coming soon.</p>
    </main>
  );
}
