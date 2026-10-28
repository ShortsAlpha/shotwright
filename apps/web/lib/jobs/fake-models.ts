/**
 * Stand-ins for the models, for trying the explore flow without API keys or credits
 * (SHOTWRIGHT_FAKE_MODELS=1). The real explore(), recorder and replay run unchanged; only the model
 * turns and the screen judge are scripted. The script fits the fake app of `shotwright-agent connect
 * --fake`; on any other app it marks the start screen and stops.
 */
import {
  priceOf,
  type ExplorerProvider,
  type HistoryItem,
  type JudgeOptions,
  type JudgeResult,
  type ProviderTurn,
  type ToolCall,
  type TurnRequest,
  type Usage,
} from "@shotwright/explorer";

interface ScriptTurn {
  readonly think: string;
  readonly mark?: { readonly name: string; readonly why: string; readonly score: number };
  /** Accessibility identifier to tap. */
  readonly tap?: string;
  readonly reason?: string;
  readonly done?: boolean;
}

const SCRIPT: readonly ScriptTurn[] = [
  {
    think: "The start screen shows the monthly total and every upcoming renewal. That is the hero shot. I'll mark it, then open a subscription.",
    mark: { name: "home-overview", why: "Monthly total and every upcoming renewal at a glance.", score: 10 },
    tap: "row.netflix",
    reason: "Open a subscription to see its detail screen.",
  },
  {
    think: "A colourful detail card with the price and next renewal. Worth having; then back to the list.",
    mark: { name: "subscription-detail", why: "A detail card with the price and the next renewal date.", score: 8 },
    tap: "BackButton",
    reason: "Go back to the list.",
  },
  { think: "The tab bar has a calendar. Timelines make good screenshots.", tap: "calendar", reason: "Open the Calendar tab." },
  {
    think: "Renewal days are highlighted on a month grid: clear and visual.",
    mark: { name: "calendar-month", why: "Renewal days highlighted on a month grid.", score: 9 },
    tap: "chart.pie",
    reason: "Look at the spending insights.",
  },
  {
    think: "A chart of spending by service, visually different from the other screens.",
    mark: { name: "insights-spend", why: "Spending broken down by service in a chart.", score: 9 },
    tap: "house",
    reason: "Back to Home to check another subscription.",
  },
  { think: "Disney+ may show a trial, which is a different story to tell.", tap: "row.disney", reason: "Open Disney+." },
  {
    think: "Same layout as the first detail screen, so it is a backup. I have enough strong screens.",
    mark: { name: "disney-detail", why: "Another detail card, in a different brand colour.", score: 6 },
    done: true,
  },
];

const RANKED = ["home-overview", "calendar-month", "insights-spend", "subscription-detail", "disney-detail"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Text of the newest observation the explorer sent. */
function latestObservation(history: readonly HistoryItem[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i]!;
    if (item.kind !== "assistant" && item.observation) return item.observation.text;
  }
  return "";
}

/** The ref ("e7") of the element with this identifier in an observation's element list. */
function refFor(observation: string, identifier: string): string | undefined {
  for (const line of observation.split("\n")) {
    const match = /^(e\d+)\s/.exec(line);
    if (match && line.includes(` #${identifier} `)) return match[1];
  }
  return undefined;
}

export class ScriptedProvider implements ExplorerProvider {
  readonly id = "scripted";
  readonly model = "scripted (priced as muse-spark-1.3)";
  readonly mode = "tools" as const;
  private turn = 0;
  private readonly marked: string[] = [];

  async next(request: TurnRequest): Promise<ProviderTurn> {
    const turn = this.turn++;
    const ms = 700 + Math.round(Math.random() * 700);
    await sleep(ms);
    const usage: Usage = {
      input: 2600 + 450 * turn,
      cachedInput: turn === 0 ? 0 : Math.round(0.75 * (2600 + 450 * turn)),
      output: 110 + 15 * turn,
      reasoning: 60,
    };
    const step = SCRIPT[turn];
    const observation = latestObservation(request.history);
    const calls: ToolCall[] = [];
    const call = (name: string, args: Record<string, unknown>) => calls.push({ id: `call_${turn}_${calls.length}`, name, args });

    const ref = step?.tap ? refFor(observation, step.tap) : undefined;
    if (!step || (step.tap && !ref)) {
      // Not the fake app (or off script): mark what is there once, then finish.
      if (this.marked.length === 0) {
        call("mark_screen", { name: "start-screen", why: "The first screen of the app.", marketing_score: 7 });
        this.marked.push("start-screen");
      }
      call("done", { ranked: this.marked, notes: "Scripted run (SHOTWRIGHT_FAKE_MODELS=1); the script did not match this app." });
      return { text: "", calls, usage, ms, reasoning: "This screen is not in my script, so I'll stop here." };
    }
    if (step.mark) {
      call("mark_screen", { name: step.mark.name, why: step.mark.why, marketing_score: step.mark.score });
      this.marked.push(step.mark.name);
    }
    if (ref) call("tap", { element_id: ref, reason: step.reason });
    if (step.done) call("done", { ranked: RANKED.filter((n) => this.marked.includes(n)), notes: "Scripted run (SHOTWRIGHT_FAKE_MODELS=1)." });
    return { text: "", calls, usage, ms, reasoning: step.think };
  }

  cost(usage: Usage): number {
    return priceOf("muse-spark-1.3", usage);
  }

  listCost(usage: Usage): number {
    return priceOf("muse-spark-1.3", usage);
  }
}

const CAPTIONS: Record<string, string> = {
  "home-overview": "All your renewals at a glance",
  "calendar-month": "Never miss a due date",
  "insights-spend": "Know where your money goes",
  "subscription-detail": "Every charge in detail",
  "disney-detail": "Catch trials before they bill",
  "start-screen": "Everything in one place",
};

/** The screen judge's answer, canned: preferred order, captions from a table. */
export async function stubJudge(options: JudgeOptions): Promise<JudgeResult> {
  await sleep(1500);
  const names = options.screens.map((s) => s.name);
  const order = [...RANKED.filter((n) => names.includes(n)), ...names.filter((n) => !RANKED.includes(n))];
  return {
    model: "stub judge (SHOTWRIGHT_FAKE_MODELS=1)",
    ranking: order.map((name, i) => ({
      name,
      rank: i + 1,
      score: Math.max(3, 10 - i - (i > 2 ? 1 : 0)),
      caption: CAPTIONS[name] ?? name.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
      reason: i < 3 ? "Distinct, content-rich screen that shows the core value." : "Close to another screen; keep it near the end.",
    })),
    notes: "Lead with the overview, the calendar and the chart; the detail screens look alike.",
    usage: { input: 0, cachedInput: 0, output: 0, reasoning: 0 },
    ms: 1500,
    listCostUsd: 0,
    structuredOutput: true,
  };
}
