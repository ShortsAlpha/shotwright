"use client";

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_LOCALES, type ExplorerModel } from "../../lib/jobs/state.ts";

/** What the Project panel collects. Remembered in this browser between visits. */
export interface ExploreForm {
  /** Folder on the Mac to search for projects; empty = where the agent runs. */
  readonly root: string;
  readonly projectPath: string;
  readonly scheme: string;
  readonly launchArgs: string;
  readonly hint: string;
  readonly locales: readonly string[];
  readonly model: ExplorerModel;
}

const KEY = "shotwright.explore.v1";

const INITIAL: ExploreForm = {
  root: "",
  projectPath: "",
  scheme: "",
  launchArgs: "",
  hint: "",
  locales: DEFAULT_LOCALES,
  model: "spark",
};

export function useExploreForm(): [ExploreForm, (patch: Partial<ExploreForm>) => void] {
  const [form, setForm] = useState<ExploreForm>(INITIAL);

  // Restore after mount (the server render has no storage).
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<ExploreForm> | null;
      if (saved && typeof saved === "object") setForm((f) => ({ ...f, ...saved }));
    } catch {
      // Private window or blocked storage: start empty.
    }
  }, []);

  const update = useCallback((patch: Partial<ExploreForm>) => {
    setForm((previous) => {
      const next = { ...previous, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Not remembered; fine.
      }
      return next;
    });
  }, []);

  return [form, update];
}
