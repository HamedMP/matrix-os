"use client";

import { useState } from "react";
import type { ProjectHomeView } from "@matrix-os/ui/project-board";

const STORAGE_PREFIX = "matrix:project-home-view:v1:web:";

function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch (error: unknown) {
    console.warn("[chat] project view storage unavailable", error instanceof Error ? error.name : typeof error);
    return undefined;
  }
}

export function readProjectHomeView(storage: Pick<Storage, "getItem"> | undefined, projectId: string): ProjectHomeView {
  try {
    return storage?.getItem(`${STORAGE_PREFIX}${projectId}`) === "board" ? "board" : "overview";
  } catch (error: unknown) {
    console.warn("[chat] project view could not be read", error instanceof Error ? error.name : typeof error);
    return "overview";
  }
}

export function writeProjectHomeView(storage: Pick<Storage, "setItem"> | undefined, projectId: string, view: ProjectHomeView): void {
  try {
    storage?.setItem(`${STORAGE_PREFIX}${projectId}`, view);
  } catch (error: unknown) {
    console.warn("[chat] project view could not be saved", error instanceof Error ? error.name : typeof error);
  }
}

/** The Overview | Board choice on a Web Desktop / Web Canvas project page, remembered per project. */
export function useProjectHomeView(projectId: string | undefined): [ProjectHomeView, (view: ProjectHomeView, forProjectId?: string) => void] {
  const [state, setState] = useState<{ projectId: string; view: ProjectHomeView } | null>(null);
  let current = state;
  if (projectId && state?.projectId !== projectId) {
    current = { projectId, view: readProjectHomeView(browserStorage(), projectId) };
    setState(current);
  }
  // `forProjectId` sets the view of a project that is not shown yet, for example before opening it from a chat.
  const setView = (view: ProjectHomeView, forProjectId = projectId) => {
    if (!forProjectId) return;
    setState({ projectId: forProjectId, view });
    writeProjectHomeView(browserStorage(), forProjectId, view);
  };
  return [current?.view ?? "overview", setView];
}

/** Board filters and layout share the same per-project, per-surface memory. */
export function projectBoardStorage(): Storage | undefined {
  return browserStorage();
}
