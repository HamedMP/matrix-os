import { Command } from "cmdk";
import { Notebook } from "@renderer/lib/hugeicons";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AgentThreadSummary, ReviewSummary, RuntimeSummary, TerminalSessionSummary } from "@matrix-os/contracts";
import { ClipboardCheck, GitBranch, Globe2, Kanban, LayoutGrid, MessageSquarePlus, PanelsTopLeft, Plus, Search, Settings, Sparkles, SquareTerminal } from "@renderer/lib/hugeicons";
import { appIconUrl, useApps } from "../../stores/apps";
import { useBoard } from "../../stores/board";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useConnection } from "../../stores/connection";
import { useShellSessions, type ShellSessionSummary } from "../../stores/shell-sessions";
import { useTabs } from "../../stores/tabs";
import { useThreads } from "../../stores/threads";
import { useUi } from "../../stores/ui";
import { CODING_AGENTS_DESKTOP_WORKSPACE, NATIVE_DESKTOP_WINDOW_SHELL } from "../../lib/feature-flags";
import { defaultProjectId, openCodingAgentThread, openProjectChat } from "../../lib/project-chat";
import { openProjectOverview } from "../../lib/project-navigation";
import { HOSTED_SHELL_TAB_SPEC } from "../../lib/hosted-shell";
import { handleNewAgentRunShortcut } from "../mission-control/shortcuts";
import { openProviderSetupTerminal, providerSetupCommands, type ProviderSetupCommand } from "../coding-agents/provider-setup-terminal";

const EMPTY_REVIEWS: ReviewSummary[] = [];
const MAX_PALETTE_REVIEWS = 10;
const MAX_PALETTE_THREADS = 20;
const MAX_PALETTE_TERMINALS = 20;
const GENERIC_THREAD_TITLE = "Coding agent run";
const TERMINAL_REVIEW_STATUSES: ReviewSummary["status"][] = ["approved", "converged", "stopped"];
const SESSION_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,29}[a-z0-9])?$/;
const SETUP_DISCONNECTED_ERROR = "Connect to your Matrix computer before opening setup.";
const SETUP_TERMINAL_ERROR = "Could not open setup terminal. Try again from Terminal.";
type PaletteCategory = "all" | "projects" | "actions" | "settings";
const PALETTE_CATEGORIES: Array<{ id: PaletteCategory; label: string }> = [
  { id: "all", label: "All" },
  { id: "projects", label: "Projects" },
  { id: "actions", label: "Actions" },
  { id: "settings", label: "Settings" },
];

function isTerminalReviewStatus(status: ReviewSummary["status"]): boolean {
  return TERMINAL_REVIEW_STATUSES.includes(status);
}

function reviewUpdatedAtMs(review: ReviewSummary): number {
  const value = Date.parse(review.updatedAt);
  return Number.isFinite(value) ? value : 0;
}

function paletteReviewCommands(reviews: ReviewSummary[]): ReviewSummary[] {
  return [...reviews]
    .sort((a, b) => {
      const statusPriority = Number(isTerminalReviewStatus(a.status)) - Number(isTerminalReviewStatus(b.status));
      if (statusPriority !== 0) return statusPriority;
      const updatedPriority = reviewUpdatedAtMs(b) - reviewUpdatedAtMs(a);
      if (updatedPriority !== 0) return updatedPriority;
      const pullRequestPriority = b.pullRequestNumber - a.pullRequestNumber;
      if (pullRequestPriority !== 0) return pullRequestPriority;
      return a.id.localeCompare(b.id);
    })
    .slice(0, MAX_PALETTE_REVIEWS);
}

interface PaletteThreadCommand {
  thread: AgentThreadSummary;
  title: string;
}

function contextualAgentRunTitle(thread: AgentThreadSummary): string {
  const context = thread.projectId?.trim() || thread.taskId?.trim() || thread.providerId;
  return `${context} agent run`;
}

function linkedThreadTitle(
  thread: AgentThreadSummary,
  summary: RuntimeSummary,
  shellSessions: ShellSessionSummary[],
): string {
  const persistedTitle = thread.title.trim();
  if (persistedTitle.toLocaleLowerCase() !== GENERIC_THREAD_TITLE.toLocaleLowerCase()) {
    return persistedTitle;
  }
  if (!thread.terminalSessionId) return contextualAgentRunTitle(thread);
  const terminalSession = summary.terminalSessions.items.find((session) => (
    session.id === thread.terminalSessionId
  ));
  if (!terminalSession) return contextualAgentRunTitle(thread);
  const shellSession = shellSessions.find((session) => session.name === terminalSession.name);
  const agentTitle = shellSession?.subtitle?.trim();
  if (agentTitle && agentTitle.toLocaleLowerCase() !== GENERIC_THREAD_TITLE.toLocaleLowerCase()) {
    return agentTitle;
  }
  return terminalSession.name;
}

function paletteThreadCommands(
  summary: RuntimeSummary | null,
  shellSessions: ShellSessionSummary[],
): PaletteThreadCommand[] {
  if (!summary) return [];
  const commands: PaletteThreadCommand[] = [];
  const seen = new Set<string>();
  for (const thread of [...summary.attentionThreads.items, ...summary.activeThreads.items]) {
    if (seen.has(thread.id)) continue;
    seen.add(thread.id);
    commands.push({ thread, title: linkedThreadTitle(thread, summary, shellSessions) });
    if (commands.length >= MAX_PALETTE_THREADS) break;
  }
  return commands;
}

function paletteTerminalCommands(
  summary: { terminalSessions?: { items: TerminalSessionSummary[] } } | null,
  shellSessions: Array<{ name: string }>,
): TerminalSessionSummary[] {
  if (!summary?.terminalSessions) return [];
  const shellSessionNames = new Set(shellSessions.map((session) => session.name));
  const commands: TerminalSessionSummary[] = [];
  const seen = new Set<string>();
  for (const session of summary.terminalSessions.items) {
    if (
      !session.attachable
      || !SESSION_NAME_PATTERN.test(session.name)
      || shellSessionNames.has(session.name)
      || seen.has(session.name)
    ) continue;
    seen.add(session.name);
    commands.push(session);
    if (commands.length >= MAX_PALETTE_TERMINALS) break;
  }
  return commands;
}

export default function CommandPalette() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [category, setCategory] = useState<PaletteCategory>("all");
  const [query, setQuery] = useState("");
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const openTab = useTabs((s) => s.openTab);
  const focusTab = useTabs((s) => s.focusTab);
  const tabs = useTabs((s) => s.tabs);
  const activeTabId = useTabs((s) => s.activeTabId);
  const setCreateTaskOpen = useUi((s) => s.setCreateTaskOpen);
  const setCreateProjectOpen = useUi((s) => s.setCreateProjectOpen);
  const activeSlug = useBoard((s) => s.activeProjectSlug);
  const projects = useBoard((s) => s.projects);
  const cardsByProject = useBoard((s) => s.cardsByProject);
  const shellSessions = useShellSessions((s) => s.sessions);
  const loadShellSessions = useShellSessions((s) => s.load);
  const apps = useApps((s) => s.apps);
  const appsError = useApps((s) => s.error);
  const loadApps = useApps((s) => s.load);
  const summary = useCodingAgentWorkspace((s) => s.summary);
  const reviews = useCodingAgentWorkspace((s) => s.reviews);
  const selectReview = useCodingAgentWorkspace((s) => s.selectReview);
  const api = useConnection((s) => s.api);
  const platformHost = useConnection((s) => s.platformHost);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);

  // Make sure apps are available the first time the palette opens.
  useEffect(() => {
    if (open && api) void loadApps(api, Boolean(appsError));
  }, [open, api, appsError, loadApps]);

  useEffect(() => {
    if (open && api) void loadShellSessions(api);
  }, [open, api, loadShellSessions]);

  useEffect(() => {
    if (open) {
      setActionError(null);
      setCategory("all");
      setQuery("");
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    inputRef.current?.focus();
    const focusFrame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(focusFrame);
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    };
  }, [open]);

  if (!open) return null;

  const cards = activeSlug ? (cardsByProject[activeSlug] ?? []) : [];
  const otherTabs = tabs.filter((t) => t.id !== activeTabId);
  const reviewCommands = CODING_AGENTS_DESKTOP_WORKSPACE ? paletteReviewCommands(reviews?.items ?? EMPTY_REVIEWS) : EMPTY_REVIEWS;
  const threadCommands = CODING_AGENTS_DESKTOP_WORKSPACE ? paletteThreadCommands(summary, shellSessions) : [];
  const terminalCommands = CODING_AGENTS_DESKTOP_WORKSPACE ? paletteTerminalCommands(summary, shellSessions) : [];
  const setupCommands = CODING_AGENTS_DESKTOP_WORKSPACE ? providerSetupCommands(summary?.providers ?? []) : [];
  const showActions = category === "all" || category === "actions";
  const showProjects = category === "all" || category === "projects";
  const showSettings = category === "all" || category === "settings";

  const run = (fn: () => void) => {
    setActionError(null);
    setOpen(false);
    fn();
  };

  const runProviderSetup = async (setup: ProviderSetupCommand) => {
    setActionError(null);
    if (!api) {
      setActionError(SETUP_DISCONNECTED_ERROR);
      return;
    }
    const opened = await openProviderSetupTerminal(api, setup, openTab, "palette");
    if (opened) {
      setOpen(false);
    } else {
      setActionError(SETUP_TERMINAL_ERROR);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-label="Command palette"
      className="fixed inset-0 z-50 m-0 flex h-screen max-h-none w-screen max-w-none items-start justify-center border-0 bg-transparent p-0 pt-[8vh]"
      onCancel={(e) => {
        e.preventDefault();
        setOpen(false);
      }}
    >
      <button
        type="button"
        aria-label="Close command palette"
        tabIndex={-1}
        className="absolute inset-0 h-full w-full cursor-default border-0 p-0"
        style={{ background: "rgba(0,0,0,0.45)" }}
        onClick={() => setOpen(false)}
      />
      <Command
        label="Search commands"
        className="fade-in relative z-10 w-[min(760px,calc(100vw-32px))] overflow-hidden rounded-2xl border"
        style={{
          background: "var(--bg-overlay)",
          borderColor: "var(--border-default)",
          boxShadow: "var(--shadow-3)",
        }}
        onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Escape") setOpen(false);
        }}
      >
        <div className="flex h-16 items-center gap-3 border-b px-5" style={{ borderColor: "var(--border-subtle)" }}>
          <Search size={24} aria-hidden="true" style={{ color: "var(--text-tertiary)" }} />
          <Command.Input
            ref={inputRef}
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Type a command or search…"
            className="min-w-0 flex-1 rounded-none bg-transparent text-lg outline-none focus-visible:shadow-none"
            style={{ color: "var(--text-primary)" }}
          />
          <kbd className="rounded-full border px-2.5 py-1 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>⌘K</kbd>
        </div>
        <div role="tablist" aria-label="Command categories" className="flex h-11 items-stretch gap-1 border-b px-4" style={{ borderColor: "var(--border-subtle)" }}>
          {PALETTE_CATEGORIES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={category === item.id}
              className="relative px-3 text-sm font-medium"
              style={{ color: category === item.id ? "var(--text-primary)" : "var(--text-secondary)" }}
              onClick={() => {
                setCategory(item.id);
                setQuery("");
                window.requestAnimationFrame(() => inputRef.current?.focus());
              }}
            >
              {item.label}
              {category === item.id ? <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full" style={{ background: "var(--accent)" }} /> : null}
            </button>
          ))}
        </div>
        {actionError ? (
          <div className="border-b px-4 py-2 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--danger)" }}>
            {actionError}
          </div>
        ) : null}
        <Command.List className="max-h-[min(560px,68vh)] overflow-y-auto p-3">
          <Command.Empty
            className="px-3 py-6 text-center text-sm"
            style={{ color: "var(--text-tertiary)" }}
          >
            No results.
          </Command.Empty>

          {showActions ? <Command.Group
            heading="Actions"
            className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide"
            style={{ color: "var(--text-tertiary)" }}
          >
            <PaletteItem icon={<Plus size={14} />} label="New task" shortcut="C" onSelect={() => run(() => setCreateTaskOpen(true))} />
            <PaletteItem
              icon={<Kanban size={14} />}
              label="Add project…"
              keywords={["new", "project", "create", "clone", "folder", "github"]}
              onSelect={() => run(() => setCreateProjectOpen(true))}
            />
            <PaletteItem
              icon={<Sparkles size={14} />}
              label="Open chat"
              onSelect={() =>
                run(() => {
                  useThreads.getState().setActiveThread(null);
                  openTab({ kind: "chat", title: "Hermes", closable: false });
                })
              }
            />
            <PaletteItem
              icon={<MessageSquarePlus size={14} />}
              label="New agent run"
              shortcut="⌘J"
              onSelect={() =>
                run(() => {
                  handleNewAgentRunShortcut(
                    { preventDefault: () => undefined },
                    useUi.getState(),
                    useCodingAgentWorkspace.getState(),
                  );
                })
              }
            />
            {setupCommands.map((setup) => (
              <PaletteItem
                key={setup.key}
                icon={<SquareTerminal size={14} />}
                label={setup.label}
                onSelect={() =>
                  void runProviderSetup(setup)
                }
              />
            ))}
            <PaletteItem icon={<Globe2 size={14} />} label="Open Browser" onSelect={() => run(() => openTab(HOSTED_SHELL_TAB_SPEC))} />
            <PaletteItem icon={<SquareTerminal size={14} />} label="Open Terminal" onSelect={() => run(() => openTab({ kind: "terminals", title: "Terminal" }))} />
            <PaletteItem icon={<Notebook size={14} />} label="Open Notes" onSelect={() => run(() => openTab({ kind: "notes", title: "Notes" }))} />
            <PaletteItem
              icon={<LayoutGrid size={14} />}
              label="Open Apps"
              onSelect={() => run(() => {
                if (NATIVE_DESKTOP_WINDOW_SHELL) useUi.getState().setAppLauncherOpen(true);
                else openTab({ kind: "apps", title: "Apps" });
              })}
            />
          </Command.Group> : null}

          {showSettings ? (
            <Command.Group heading="Settings" style={{ color: "var(--text-tertiary)" }}>
              <PaletteItem
                icon={<Settings size={14} />}
                label="Open settings"
                shortcut="⌘,"
                keywords={["preferences", "services", "integrations", "account", "runtime"]}
                onSelect={() => run(() => openTab({ kind: "settings", title: "Settings" }))}
              />
            </Command.Group>
          ) : null}

          {showProjects && projects.length > 0 ? (
            <Command.Group heading="Recent projects" style={{ color: "var(--text-tertiary)" }}>
              {projects.slice(0, 20).map((p) => (
                <PaletteItem
                  key={p.slug}
                  icon={<Kanban size={14} />}
                  label={p.name || p.slug}
                  onSelect={() => run(() => openProjectOverview(p.slug, p.name || p.slug))}
                />
              ))}
            </Command.Group>
          ) : null}

          {showProjects && cards.length > 0 ? (
            <Command.Group heading="Tasks" style={{ color: "var(--text-tertiary)" }}>
              {cards.slice(0, 30).map((card) => (
                <PaletteItem
                  key={card.id}
                  icon={<Kanban size={14} />}
                  label={card.title}
                  onSelect={() => run(() => openTab({ kind: "task", taskId: card.id, projectSlug: card.projectSlug, title: card.title }))}
                />
              ))}
            </Command.Group>
          ) : null}

          {showProjects && reviewCommands.length > 0 ? (
            <Command.Group heading="Reviews" style={{ color: "var(--text-tertiary)" }}>
              {reviewCommands.map((review) => (
                <PaletteItem
                  key={review.id}
                  icon={<ClipboardCheck size={14} />}
                  label={`Open review PR #${review.pullRequestNumber}`}
                  onSelect={() =>
                    run(() => {
                      // Reviews surface in the Changes tab of their project's
                      // Chats view; the review focus request forces the pane.
                      const projectId = review.projectId ?? defaultProjectId();
                      if (projectId) void openProjectChat(projectId);
                      void selectReview(review.id);
                    })
                  }
                />
              ))}
            </Command.Group>
          ) : null}

          {showProjects && threadCommands.length > 0 ? (
            <Command.Group heading="Threads" style={{ color: "var(--text-tertiary)" }}>
              {threadCommands.map(({ thread, title }) => (
                <PaletteItem
                  key={thread.id}
                  icon={<GitBranch size={14} />}
                  label={`Open thread ${title}`}
                  keywords={[thread.title, thread.providerId, title]}
                  onSelect={() =>
                    run(() => void openCodingAgentThread(thread.id))
                  }
                />
              ))}
            </Command.Group>
          ) : null}

          {showActions && terminalCommands.length > 0 ? (
            <Command.Group heading="Agent terminals" style={{ color: "var(--text-tertiary)" }}>
              {terminalCommands.map((session) => (
                <PaletteItem
                  key={session.id}
                  icon={<SquareTerminal size={14} />}
                  label={`Open terminal ${session.name}`}
                  onSelect={() =>
                    run(() => openTab({ kind: "terminal", sessionName: session.name, title: session.name }))
                  }
                />
              ))}
            </Command.Group>
          ) : null}

          {showActions && shellSessions.length > 0 ? (
            <Command.Group heading="Sessions" style={{ color: "var(--text-tertiary)" }}>
              {shellSessions.slice(0, 20).map((session) => {
                const label = session.name;
                return (
                  <PaletteItem
                    key={session.name}
                    icon={<SquareTerminal size={14} />}
                    label={label}
                    onSelect={() =>
                      run(() => openTab({ kind: "terminal", sessionName: session.name, title: label }))
                    }
                  />
                );
              })}
            </Command.Group>
          ) : null}

          {showActions && apps.length > 0 ? (
            <Command.Group heading="Apps" style={{ color: "var(--text-tertiary)" }}>
              {apps.slice(0, 30).map((app) => (
                <PaletteItem
                  key={app.slug}
                  icon={<LayoutGrid size={14} />}
                  label={app.name}
                  onSelect={() => run(() => openTab({ kind: "app", slug: app.slug, title: app.name, ...(app.appIdentity ? { appIdentity: app.appIdentity } : {}), ...(appIconUrl(platformHost, app.slug, runtimeSlot) ? { icon: appIconUrl(platformHost, app.slug, runtimeSlot)! } : {}) }))}
                />
              ))}
            </Command.Group>
          ) : null}

          {showActions && otherTabs.length > 0 ? (
            <Command.Group heading="Open tabs" style={{ color: "var(--text-tertiary)" }}>
              {otherTabs.map((tab) => (
                <PaletteItem
                  key={tab.id}
                  icon={<PanelsTopLeft size={14} />}
                  label={tab.title}
                  onSelect={() => run(() => focusTab(tab.id))}
                />
              ))}
            </Command.Group>
          ) : null}
        </Command.List>
      </Command>
    </dialog>
  );
}

function PaletteItem({
  icon,
  label,
  shortcut,
  keywords,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  keywords?: string[];
  onSelect: () => void;
}) {
  return (
    <Command.Item
      data-instant-list-hover
      onSelect={onSelect}
      keywords={keywords}
      className="flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 text-sm data-[selected=true]:bg-[var(--bg-selected)]"
      style={{ color: "var(--text-primary)" }}
    >
      <span style={{ color: "var(--text-tertiary)" }}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut ? (
        <kbd className="text-xs" style={{ color: "var(--text-tertiary)" }}>
          {shortcut}
        </kbd>
      ) : null}
    </Command.Item>
  );
}
