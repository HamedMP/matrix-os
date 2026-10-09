"use client";

import { Brain } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { BrainSelect } from "./brain-controls.js";
import { BRAIN_TONE } from "./brain-tone.js";
import {
  BRAIN_SHELL_SCREENS, BRAIN_SHELL_VIEW, type BrainProjectOption, type BrainShellClient, type BrainShellScreen,
} from "./brain-types.js";
import { brainTabIndexForKey } from "./brain-format.js";
import { BrainEmpty, BrainView, type BrainScreenProps } from "./brain-ui.js";
import { BrainAsk } from "./BrainAsk.js";
import { BrainClaims } from "./BrainClaims.js";
import { BrainSources } from "./BrainSources.js";
import { BrainTimeline } from "./BrainTimeline.js";
import { BrainToday } from "./BrainToday.js";
import { useBrainLoad } from "./use-brain-load.js";

export interface BrainAppProps {
  /** The renderer's client (createBrainShellApi over its gateway transport); tests pass a fake. */
  readonly api: BrainShellClient;
  /** The owner's projects (listBrainProjects over the same transport). */
  readonly loadProjects: () => Promise<readonly BrainProjectOption[]>;
  readonly initialScreen?: BrainShellScreen;
  readonly initialProjectId?: string;
  /** The in-app heading; off where the window title bar already names the app. Default true. */
  readonly showHeading?: boolean;
}

const SCREEN_LABELS: Readonly<Record<BrainShellScreen, string>> = {
  ask: "Ask", today: "Today", decisions: "Decisions", commitments: "Commitments", risks: "Risks",
  timeline: "Timeline", sources: "Sources",
};

/** The project this viewer picked last (a per-browser convenience; the gateway still decides access). */
const PROJECT_STORAGE_KEY = "matrix-os:brain-project";
const STORED_ID_MAX_CHARS = 200;

/** Logs a storage failure by its name only (a DOMException such as SecurityError, or an Error). */
function storageFailure(error: unknown): void {
  const name = typeof error === "object" && error !== null ? (error as { readonly name?: unknown }).name : undefined;
  console.warn("[brain] remembered project unavailable", typeof name === "string" ? name.slice(0, 64) : typeof error);
}

function rememberedProject(): string {
  if (typeof window === "undefined") return "";
  try {
    return (window.localStorage.getItem(PROJECT_STORAGE_KEY) ?? "").slice(0, STORED_ID_MAX_CHARS);
  } catch (error: unknown) {
    storageFailure(error);
    return "";
  }
}

function rememberProject(projectId: string): void {
  try {
    window.localStorage.setItem(PROJECT_STORAGE_KEY, projectId.slice(0, STORED_ID_MAX_CHARS));
  } catch (error: unknown) {
    storageFailure(error);
  }
}

/** The Company Brain view: a project (the last pick if still listed, else the first), then one of seven screens. */
export function BrainApp({
  api, loadProjects, initialScreen = "ask", initialProjectId, showHeading = true,
}: BrainAppProps) {
  const projects = useBrainLoad(loadProjects, "projects");
  const [screen, setScreen] = useState<BrainShellScreen>(initialScreen);
  const [picked, setPicked] = useState(() => initialProjectId ?? rememberedProject());
  const baseId = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = brainTabIndexForKey(event.key, BRAIN_SHELL_SCREENS.indexOf(screen), BRAIN_SHELL_SCREENS.length);
    if (next === null) return;
    const target = BRAIN_SHELL_SCREENS[next];
    if (target === undefined) return;
    event.preventDefault();
    setScreen(target);
    tabs.current[next]?.focus();
  };

  return (
    <div className={`@container isolate flex h-full min-h-0 flex-1 flex-col ${BRAIN_TONE.surface}`}>
      {showHeading && (
        <header className={`flex flex-wrap items-center gap-3 border-b px-4 py-3 ${BRAIN_TONE.border}`}>
          <Brain className={`size-5 ${BRAIN_TONE.accentText}`} aria-hidden="true" />
          <h1 className="text-base font-semibold">{BRAIN_SHELL_VIEW.title}</h1>
        </header>
      )}
      <BrainView state={projects.state} label="Loading projects..." onRetry={projects.reload}>
        {(list) => {
          const project = list.find((candidate) => candidate.id === picked) ?? list[0];
          if (project === undefined) {
            return (
              <div className="p-4">
                <BrainEmpty title="No projects yet.">
                  Add a project from Files or Terminal; its brain appears here once its repository is connected.
                </BrainEmpty>
              </div>
            );
          }
          const props: BrainScreenProps = { api, projectId: project.id, onOpenSources: () => setScreen("sources") };
          return (
            <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] @2xl:grid-cols-[12rem_minmax(0,1fr)] @2xl:grid-rows-1">
              <nav aria-label="Company Brain"
                className={`grid content-start gap-3 border-b p-3 @2xl:border-r @2xl:border-b-0 ${BRAIN_TONE.border}`}>
                <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                  Project
                  <BrainSelect
                    value={project.id}
                    onChange={(event) => { setPicked(event.target.value); rememberProject(event.target.value); }}
                  >
                    {list.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                  </BrainSelect>
                </label>
                <div role="tablist" aria-label="Screens" onKeyDown={onTabKey}
                  className="flex gap-1 overflow-x-auto @2xl:flex-col @2xl:overflow-visible">
                  {BRAIN_SHELL_SCREENS.map((value, index) => (
                    <button
                      key={value}
                      ref={(node) => { tabs.current[index] = node; }}
                      type="button"
                      role="tab"
                      id={`${baseId}-tab-${value}`}
                      aria-selected={value === screen}
                      aria-controls={`${baseId}-panel`}
                      tabIndex={value === screen ? 0 : -1}
                      onClick={() => setScreen(value)}
                      className={`shrink-0 rounded-md px-3 py-1.5 text-left text-sm font-medium text-muted-foreground ${BRAIN_TONE.hover} ${BRAIN_TONE.focus} ${BRAIN_TONE.selected}`}
                    >
                      {SCREEN_LABELS[value]}
                    </button>
                  ))}
                </div>
              </nav>
              <section
                key={`${project.id}:${screen}`}
                role="tabpanel"
                id={`${baseId}-panel`}
                aria-labelledby={`${baseId}-tab-${screen}`}
                className="min-h-0 overflow-auto p-4"
              >
                <BrainScreen screen={screen} props={props} />
              </section>
            </div>
          );
        }}
      </BrainView>
    </div>
  );
}

function BrainScreen({ screen, props }: { readonly screen: BrainShellScreen; readonly props: BrainScreenProps }) {
  switch (screen) {
    case "ask": return <BrainAsk {...props} />;
    case "today": return <BrainToday {...props} />;
    case "decisions": return <BrainClaims {...props} kind="decision" />;
    case "commitments": return <BrainClaims {...props} kind="commitment" />;
    case "risks": return <BrainClaims {...props} kind="risk" />;
    case "timeline": return <BrainTimeline {...props} />;
    case "sources": return <BrainSources {...props} />;
  }
}
