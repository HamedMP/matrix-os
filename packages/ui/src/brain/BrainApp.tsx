"use client";

import { Brain, MessageSquare } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { BrainSelect } from "./brain-controls.js";
import { readRemembered, writeRemembered } from "./brain-memory.js";
import { BRAIN_THEME, BRAIN_TONE, BRAIN_TYPE } from "./brain-tone.js";
import {
  BRAIN_SHELL_SCREEN_ALIASES, BRAIN_SHELL_SCREENS, BRAIN_SHELL_VIEW, type BrainClaimKind, type BrainProjectOption,
  type BrainShellClient, type BrainShellScreen, type BrainShellScreenId,
} from "./brain-types.js";
import { brainTabIndexForKey } from "./brain-format.js";
import { BrainEmpty, BrainView, type BrainScreenProps } from "./brain-ui.js";
import { BrainAsk } from "./BrainAsk.js";
import { BrainChat, type BrainChatHost } from "./BrainChat.js";
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
  /**
   * The tab it opens on: by default Chat where `chat` is given, else Search. Older ids (ask, commitments, risks) still
   * open the screen that took them over.
   */
  readonly initialScreen?: BrainShellScreenId;
  readonly initialProjectId?: string;
  /** The in-app heading; off where the window title bar already names the app. Default true. */
  readonly showHeading?: boolean;
  /** The surface's chat view for the Chat tab; without it the tab says chat is not available here. */
  readonly chat?: BrainChatHost;
}

const SCREEN_LABELS: Readonly<Record<BrainShellScreen, string>> = {
  chat: "Chat", today: "Today", decisions: "Decisions", timeline: "Timeline", search: "Search", sources: "Sources",
};
const ALIAS_KINDS: Readonly<Partial<Record<BrainShellScreenId, BrainClaimKind>>> = {
  commitments: "commitment", risks: "risk",
};

/** The project this viewer picked last (a per-browser convenience; the gateway still decides access). */
const PROJECT_STORAGE_KEY = "matrix-os:brain-project";

function openingScreen(id: BrainShellScreenId): BrainShellScreen {
  return id in BRAIN_SHELL_SCREEN_ALIASES ? BRAIN_SHELL_SCREEN_ALIASES[id as keyof typeof BRAIN_SHELL_SCREEN_ALIASES]
    : id as BrainShellScreen;
}

/**
 * The Company Brain view: pick a project, then chat with its brain or open one of the other screens. It opens on the
 * Chat tab where the surface lends a chat view (else on Search, as Chat could only say it is not available) and on the
 * project this browser picked last when it is still listed, else the first one.
 */
export function BrainApp({
  api, loadProjects, initialScreen, initialProjectId, showHeading = true, chat,
}: BrainAppProps) {
  const projects = useBrainLoad(loadProjects, "projects");
  const opening = initialScreen ?? (chat ? "chat" : "search");
  const [screen, setScreen] = useState<BrainShellScreen>(() => openingScreen(opening));
  const [claimKind, setClaimKind] = useState<BrainClaimKind>(() => ALIAS_KINDS[opening] ?? "decision");
  const [picked, setPicked] = useState(() => initialProjectId ?? readRemembered(PROJECT_STORAGE_KEY, "project"));
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
    <div style={BRAIN_THEME}
      className={`@container isolate flex h-full min-h-0 flex-1 flex-col ${BRAIN_TONE.surface} ${BRAIN_TYPE.family} ${BRAIN_TYPE.label}`}>
      {showHeading && (
        <header className={`flex min-h-13 flex-wrap items-center gap-2 border-b px-5 py-3.5 ${BRAIN_TONE.border}`}>
          <Brain className="size-5" aria-hidden="true" />
          <h1 className={`font-semibold ${BRAIN_TYPE.body}`}>{BRAIN_SHELL_VIEW.title}</h1>
        </header>
      )}
      {/* Loading and errors keep the 20 px screen margin; the ready view lays out its own. */}
      <div className={projects.state.status === "ready" ? "contents" : "p-5"}>
        <BrainView state={projects.state} label="Loading projects..." onRetry={projects.reload}>
          {(list) => {
            const project = list.find((candidate) => candidate.id === picked) ?? list[0];
            if (project === undefined) {
              return (
                <div className="p-5">
                  <BrainEmpty title="No projects yet.">
                    Add a project from Files or Terminal; its brain appears here once its repository is connected.
                  </BrainEmpty>
                </div>
              );
            }
            const props: BrainScreenProps = { api, projectId: project.id, onOpenSources: () => setScreen("sources") };
            // One column that may be narrower than the tab row, so on a phone the tabs scroll and nothing is cut off.
            return (
              <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)]">
                <nav aria-label="Company Brain"
                  className={`flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-5 py-2 ${BRAIN_TONE.border}`}>
                  <label className={`flex min-w-0 items-center gap-2 font-medium ${BRAIN_TYPE.label} ${BRAIN_TONE.secondary}`}>
                    Project
                    <BrainSelect
                      className="min-w-0 max-w-48"
                      value={project.id}
                      onChange={(event) => {
                        setPicked(event.target.value);
                        writeRemembered(PROJECT_STORAGE_KEY, event.target.value, "project");
                      }}
                    >
                      {list.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                    </BrainSelect>
                  </label>
                  <div role="tablist" aria-label="Screens" onKeyDown={onTabKey}
                    className="flex min-w-0 max-w-full gap-1 overflow-x-auto">
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
                        className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-[8px] px-3 font-medium ${
                          BRAIN_TYPE.label} ${BRAIN_TONE.secondary} hover:text-[var(--brain-text)] ${BRAIN_TONE.motion} ${
                          BRAIN_TONE.hover} ${BRAIN_TONE.focus} ${BRAIN_TONE.selected}`}
                      >
                        {value === "chat" && <MessageSquare className="size-4" aria-hidden="true" />}
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
                  className={screen === "chat" ? "flex min-h-0 flex-col" : "min-h-0 overflow-auto p-5"}
                >
                  {screen === "chat" ? (
                    <BrainChat host={chat} api={api} projectId={project.id} projectName={project.name}
                      onOpenSearch={() => setScreen("search")} onOpenSources={props.onOpenSources} />
                  ) : <BrainScreen screen={screen} props={props} claimKind={claimKind} onClaimKind={setClaimKind} />}
                </section>
              </div>
            );
          }}
        </BrainView>
      </div>
    </div>
  );
}

function BrainScreen({ screen, props, claimKind, onClaimKind }: {
  readonly screen: Exclude<BrainShellScreen, "chat">; readonly props: BrainScreenProps;
  readonly claimKind: BrainClaimKind; readonly onClaimKind: (kind: BrainClaimKind) => void;
}) {
  switch (screen) {
    case "search": return <BrainAsk {...props} />;
    case "today": return <BrainToday {...props} />;
    case "decisions": return <BrainClaims {...props} kind={claimKind} onKindChange={onClaimKind} />;
    case "timeline": return <BrainTimeline {...props} />;
    case "sources": return <BrainSources {...props} />;
  }
}
