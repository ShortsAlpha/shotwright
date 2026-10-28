/**
 * Turns an exploration's wander into a short flow.
 *
 * Every executed action is an edge between two screen fingerprints; every (re)launch is an edge
 * from START. When the exploration ends, the flow visits the marked screens in the order they were
 * marked, taking the cheapest known path to each one: from the previous marked screen, or from a
 * fresh launch when that is shorter. Before each screenshot a `waitFor` on an identifier that
 * only the target screen has makes the flow verify itself on replay.
 */
import { FlowSchema, type Flow, type FlowStep, type LaunchStep, type SwipeStep, type TapStep, type TypeTextStep } from "@shotwright/core";
import type { Observation } from "./observe.ts";

type ActionStep = TapStep | SwipeStep | TypeTextStep;

export interface StateInfo {
  readonly fingerprint: string;
  readonly identifiers: readonly string[];
  readonly anchorIds: readonly string[];
  readonly structure: readonly string[];
  readonly lines: readonly string[];
  readonly title: string | undefined;
  readonly observationIndex: number;
}

export interface MarkedScreen {
  readonly name: string;
  readonly why: string;
  readonly score: number;
  readonly state: string;
  readonly observationIndex: number;
}

/** Sidecar for each screenshot step: what the screen looked like during exploration. */
export interface ScreenRecord {
  readonly name: string;
  readonly why: string;
  readonly score: number;
  readonly title: string | undefined;
  readonly fingerprint: string;
  readonly identifiers: readonly string[];
  readonly structure: readonly string[];
  readonly observationIndex: number;
  /** Steps from the previous screenshot (or launch) to this one in the recorded flow. */
  readonly pathSteps: number;
  readonly viaRelaunch: boolean;
  /** Reached by its literal path (see BuildOptions.literal). */
  readonly literal?: boolean;
  readonly anchor?: string;
}

export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly step: ActionStep | "launch";
  readonly cost: number;
}

const START = "START";
const LAUNCH_COST = 4;

function stepCost(step: ActionStep): number {
  switch (step.action) {
    case "tap":
      return step.target.id ? 1 : 1.3; // label-only taps break in other locales more often
    case "swipe":
      return 1.1;
    case "typeText":
      return 1.2;
  }
}

/** Screens whose element lines overlap this much are treated as one node when finding paths. */
export const SAME_SCREEN_SIMILARITY = 0.9;

function lineSimilarity(a: readonly string[], b: readonly string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let both = 0;
  for (const x of A) if (B.has(x)) both++;
  return both / (A.size + B.size - both);
}

/** What happened, in order: the literal trajectory, used when a shortcut through the graph fails. */
export type TrajectoryEvent =
  | { readonly kind: "launch"; readonly state: string }
  | { readonly kind: "action"; readonly from: string; readonly step: ActionStep; readonly to: string }
  | { readonly kind: "mark"; readonly name: string; readonly state: string };

export interface RecorderGraph {
  readonly states: StateInfo[];
  readonly edges: Edge[];
  readonly marks: MarkedScreen[];
  readonly launchStates: string[];
  readonly events?: TrajectoryEvent[];
}

export interface BuildOptions {
  /**
   * Screens to reach by their literal path (relaunch, then the actions actually taken since the
   * last launch, minus loops) instead of the shortest path through the graph. For screens whose
   * shortcut failed verification: the graph cannot see hidden state (a list filter that another
   * tab remembers, say).
   */
  readonly literal?: ReadonlySet<string>;
}

export class FlowRecorder {
  readonly states = new Map<string, StateInfo>();
  readonly edges: Edge[] = [];
  readonly marks: MarkedScreen[] = [];
  readonly launchStates: string[] = [];
  readonly events: TrajectoryEvent[] = [];

  /** Rebuilds a recorder from `toJSON()` output, e.g. to rebuild a flow with different rules. */
  static fromJSON(graph: RecorderGraph): FlowRecorder {
    const recorder = new FlowRecorder();
    for (const state of graph.states) recorder.states.set(state.fingerprint, state);
    recorder.edges.push(...graph.edges);
    recorder.marks.push(...graph.marks);
    recorder.launchStates.push(...graph.launchStates);
    recorder.events.push(...(graph.events ?? []));
    return recorder;
  }

  toJSON(): RecorderGraph {
    return { states: [...this.states.values()], edges: this.edges, marks: this.marks, launchStates: this.launchStates, events: this.events };
  }

  noteState(observation: Observation): void {
    if (this.states.has(observation.fingerprint)) return;
    this.states.set(observation.fingerprint, {
      fingerprint: observation.fingerprint,
      identifiers: observation.identifiers,
      anchorIds: observation.anchorIds,
      structure: observation.structure,
      lines: observation.lines,
      title: observation.title,
      observationIndex: observation.index,
    });
  }

  recordLaunch(state: string): void {
    this.launchStates.push(state);
    this.events.push({ kind: "launch", state });
    if (!this.edges.some((e) => e.from === START && e.to === state)) {
      this.edges.push({ from: START, to: state, step: "launch", cost: LAUNCH_COST });
    }
  }

  recordTransition(from: string, step: ActionStep, to: string): void {
    if (from === to) return;
    this.edges.push({ from, to, step, cost: stepCost(step) });
    this.events.push({ kind: "action", from, step, to });
  }

  /** Returns the existing mark when this exact state is already marked (under another name). */
  mark(screen: MarkedScreen): MarkedScreen | undefined {
    const existing = this.marks.find((m) => m.state === screen.state);
    if (existing) return existing;
    this.marks.push(screen);
    this.events.push({ kind: "mark", name: screen.name, state: screen.state });
    return undefined;
  }

  /**
   * Groups near-identical screens (the same list after a round trip can differ in one label or a
   * selection flag), so a path found through one copy is usable from the other.
   */
  clusters(): Map<string, string> {
    const representative = new Map<string, string>([[START, START]]);
    const reps: StateInfo[] = [];
    for (const state of this.states.values()) {
      const match = reps.find((r) => lineSimilarity(r.lines, state.lines) >= SAME_SCREEN_SIMILARITY);
      if (match) representative.set(state.fingerprint, match.fingerprint);
      else {
        reps.push(state);
        representative.set(state.fingerprint, state.fingerprint);
      }
    }
    return representative;
  }

  /** Dijkstra over the observed edges, on clustered states. */
  shortestPath(from: string, to: string, rep: Map<string, string> = this.clusters()): { cost: number; edges: Edge[] } | undefined {
    const R = (s: string) => rep.get(s) ?? s;
    const source = R(from);
    const target = R(to);
    if (source === target) return { cost: 0, edges: [] };
    const dist = new Map<string, number>([[source, 0]]);
    const prev = new Map<string, Edge>();
    const done = new Set<string>();
    for (;;) {
      let node: string | undefined;
      let best = Infinity;
      for (const [n, d] of dist) if (!done.has(n) && d < best) [node, best] = [n, d];
      if (node === undefined) return undefined;
      if (node === target) break;
      done.add(node);
      for (const edge of this.edges) {
        if (R(edge.from) !== node || R(edge.to) === node) continue;
        const d = best + edge.cost;
        if (d < (dist.get(R(edge.to)) ?? Infinity)) {
          dist.set(R(edge.to), d);
          prev.set(R(edge.to), edge);
        }
      }
    }
    const edges: Edge[] = [];
    for (let n = target; n !== source; ) {
      const edge = prev.get(n)!;
      edges.unshift(edge);
      n = R(edge.from);
    }
    return { cost: dist.get(target)!, edges };
  }

  /** Relaunch, then the actions taken since the last launch before the mark, with loops (same exact state) cut out. */
  literalPath(name: string): { cost: number; edges: Edge[] } | undefined {
    const at = this.events.findIndex((e) => e.kind === "mark" && e.name === name);
    if (at < 0) return undefined;
    let start = -1;
    for (let i = at - 1; i >= 0; i--) {
      if (this.events[i]!.kind === "launch") {
        start = i;
        break;
      }
    }
    if (start < 0) return undefined;
    const launchEvent = this.events[start] as Extract<TrajectoryEvent, { kind: "launch" }>;
    const states = [launchEvent.state];
    const edges: Edge[] = [{ from: START, to: launchEvent.state, step: "launch", cost: LAUNCH_COST }];
    for (const event of this.events.slice(start + 1, at)) {
      if (event.kind !== "action") continue;
      const seen = states.indexOf(event.to);
      if (seen >= 0) {
        states.length = seen + 1;
        edges.length = seen + 1;
      } else {
        states.push(event.to);
        edges.push({ from: event.from, to: event.to, step: event.step, cost: stepCost(event.step) });
      }
    }
    return { cost: edges.reduce((sum, e) => sum + e.cost, 0), edges };
  }

  /** An identifier visible on the target screen but not on the screen before it (and preferably not at launch). */
  #anchor(target: string, before: string | undefined): string | undefined {
    const info = this.states.get(target);
    if (!info) return undefined;
    const prior = new Set(before && before !== START ? this.states.get(before)?.identifiers ?? [] : []);
    const atLaunch = new Set(this.launchStates.flatMap((s) => this.states.get(s)?.identifiers ?? []));
    const fresh = info.anchorIds.filter((id) => !prior.has(id));
    return fresh.find((id) => !atLaunch.has(id)) ?? fresh[0];
  }

  build(name: string, launch: LaunchStep, options: BuildOptions = {}): { flow: Flow; screens: ScreenRecord[]; warnings: string[] } {
    const steps: FlowStep[] = [launch];
    const screens: ScreenRecord[] = [];
    const warnings: string[] = [];
    const rep = this.clusters();
    const shotClusters = new Map<string, string>();
    let current = this.launchStates[0] ?? START;
    for (const mark of this.marks) {
      const cluster = rep.get(mark.state) ?? mark.state;
      const twin = shotClusters.get(cluster);
      if (twin) {
        warnings.push(`"${mark.name}" looks the same as "${twin}"; left out of the flow`);
        continue;
      }
      const literal = options.literal?.has(mark.name) ? this.literalPath(mark.name) : undefined;
      const fromCurrent = literal ? undefined : this.shortestPath(current, mark.state, rep);
      const fromStart = literal || current === START ? undefined : this.shortestPath(START, mark.state, rep);
      const path = literal ?? (fromCurrent && (!fromStart || fromCurrent.cost <= fromStart.cost) ? fromCurrent : fromStart);
      if (!path) {
        warnings.push(`no recorded path to "${mark.name}"; left out of the flow`);
        continue;
      }
      shotClusters.set(cluster, mark.name);
      let viaRelaunch = false;
      for (const edge of path.edges) {
        if (edge.step === "launch") {
          viaRelaunch = true;
          steps.push(launch);
        } else {
          steps.push(edge.step);
        }
      }
      const before = path.edges.at(-1)?.from;
      // Right after the first launch there is no previous screen: any stable identifier proves the app is up.
      const anchor =
        path.edges.length > 0 ? this.#anchor(mark.state, before) : screens.length === 0 ? this.states.get(mark.state)?.anchorIds[0] : undefined;
      if (anchor) steps.push({ action: "waitFor", target: { id: anchor }, timeoutMs: 10_000 });
      steps.push({ action: "screenshot", name: mark.name });
      const info = this.states.get(mark.state);
      screens.push({
        name: mark.name,
        why: mark.why,
        score: mark.score,
        title: info?.title,
        fingerprint: mark.state,
        identifiers: info?.identifiers ?? [],
        structure: info?.structure ?? [],
        observationIndex: mark.observationIndex,
        pathSteps: path.edges.filter((e) => e.step !== "launch").length,
        viaRelaunch,
        ...(literal ? { literal: true } : {}),
        ...(anchor ? { anchor } : {}),
      });
      current = mark.state;
    }
    return { flow: FlowSchema.parse({ version: 1, name, steps }), screens, warnings };
  }
}
