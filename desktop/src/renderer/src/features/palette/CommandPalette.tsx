import { Command } from "cmdk";
import { useEffect, useState } from "react";
import type { AgentProviderSummary, ReviewSummary, SafeSetupAction } from "@matrix-os/contracts";
import { Bot, ClipboardCheck, Home, Kanban, LayoutGrid, MessageSquarePlus, PanelsTopLeft, Plus, Settings, Sparkles, SquareTerminal } from "lucide-react";
import { appIconUrl, useApps } from "../../stores/apps";
import { useBoard } from "../../stores/board";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useConnection } from "../../stores/connection";
import { useShellSessions } from "../../stores/shell-sessions";
import { useTabs } from "../../stores/tabs";
import { useThreads } from "../../stores/threads";
import { useUi } from "../../stores/ui";
import { CODING_AGENTS_DESKTOP_WORKSPACE } from "../../lib/feature-flags";
import type { ApiClient } from "../../lib/api";

const EMPTY_REVIEWS: ReviewSummary[] = [];
const EMPTY_PROVIDERS: AgentProviderSummary[] = [];
const MAX_PALETTE_REVIEWS = 10;
const MAX_PALETTE_SETUP_ACTIONS = 10;
const TERMINAL_REVIEW_STATUSES: ReviewSummary["status"][] = ["approved", "converged", "stopped"];
const SESSION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;
const SETUP_DISCONNECTED_ERROR = "Connect to your Matrix computer before opening setup.";
const SETUP_TERMINAL_ERROR = "Could not open setup terminal. Try again from Terminal.";

type ForegroundSetupAction = Extract<SafeSetupAction, { kind: "foreground_terminal" }>;
type ProviderSetupCommand = {
  key: string;
  label: string;
  command: string;
  sessionName: string;
};

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

function safeSessionSegment(value: string): string {
  const segment = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return segment || "agent";
}

function setupSessionHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(6, "0").slice(-6);
}

function setupSessionName(providerId: string, actionId: string): string {
  const prefix = "matrix-setup-";
  const rawSegment = providerId === actionId ? providerId : `${providerId}-${actionId}`;
  const suffix = setupSessionHash(`${providerId}:${actionId}`);
  const maxSegmentLength = 31 - prefix.length - suffix.length - 1;
  const segment = safeSessionSegment(rawSegment).slice(0, maxSegmentLength).replace(/-$/g, "");
  return `${prefix}${segment || "agent"}-${suffix}`;
}

function providerSetupCommands(providers: AgentProviderSummary[]): ProviderSetupCommand[] {
  const commands: ProviderSetupCommand[] = [];
  for (const provider of providers) {
    for (const action of provider.setupActions) {
      if (action.kind !== "foreground_terminal") continue;
      const foregroundAction: ForegroundSetupAction = action;
      commands.push({
        key: `${provider.id}:${foregroundAction.id}`,
        label: foregroundAction.label,
        command: foregroundAction.command,
        sessionName: setupSessionName(provider.id, foregroundAction.id),
      });
    }
  }
  return commands.slice(0, MAX_PALETTE_SETUP_ACTIONS);
}

async function openProviderSetupTerminal(
  api: ApiClient,
  setup: ProviderSetupCommand,
  openTab: ReturnType<typeof useTabs.getState>["openTab"],
): Promise<boolean> {
  try {
    const response = await api.post<{ name?: unknown }>("/api/terminal/sessions", {
      name: setup.sessionName,
      cwd: "projects",
      cmd: setup.command,
    });
    const sessionName = typeof response.name === "string" && SESSION_NAME_PATTERN.test(response.name)
      ? response.name
      : setup.sessionName;
    openTab({ kind: "terminal", sessionName, title: setup.label });
    return true;
  } catch (err: unknown) {
    console.error("[palette] Failed to open provider setup terminal:", err instanceof Error ? err.name : typeof err);
    return false;
  }
}

export default function CommandPalette() {
  const [actionError, setActionError] = useState<string | null>(null);
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const openTab = useTabs((s) => s.openTab);
  const focusTab = useTabs((s) => s.focusTab);
  const tabs = useTabs((s) => s.tabs);
  const activeTabId = useTabs((s) => s.activeTabId);
  const setCreateTaskOpen = useUi((s) => s.setCreateTaskOpen);
  const setCreateProjectOpen = useUi((s) => s.setCreateProjectOpen);
  const setComposerOpen = useUi((s) => s.setComposerOpen);
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

  // Make sure apps are available the first time the palette opens.
  useEffect(() => {
    if (open && api) void loadApps(api, Boolean(appsError));
  }, [open, api, appsError, loadApps]);

  useEffect(() => {
    if (open && api) void loadShellSessions(api);
  }, [open, api, loadShellSessions]);

  useEffect(() => {
    if (open) setActionError(null);
  }, [open]);

  if (!open) return null;

  const cards = activeSlug ? (cardsByProject[activeSlug] ?? []) : [];
  const otherTabs = tabs.filter((t) => t.id !== activeTabId);
  const reviewCommands = CODING_AGENTS_DESKTOP_WORKSPACE ? paletteReviewCommands(reviews?.items ?? EMPTY_REVIEWS) : EMPTY_REVIEWS;
  const setupCommands = CODING_AGENTS_DESKTOP_WORKSPACE ? providerSetupCommands(summary?.providers ?? EMPTY_PROVIDERS) : [];

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
    const opened = await openProviderSetupTerminal(api, setup, openTab);
    if (opened) {
      setOpen(false);
    } else {
      setActionError(SETUP_TERMINAL_ERROR);
    }
  };

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[16vh]"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <Command
        label="Command palette"
        className="fade-in w-[560px] overflow-hidden rounded-xl border"
        style={{
          background: "var(--bg-overlay)",
          borderColor: "var(--border-default)",
          boxShadow: "var(--shadow-3)",
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      >
        <Command.Input
          autoFocus
          placeholder="Search tasks, sessions, actions…"
          className="w-full border-b bg-transparent px-4 py-3 text-md outline-none"
          style={{ borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
        />
        {actionError ? (
          <div className="border-b px-4 py-2 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--danger)" }}>
            {actionError}
          </div>
        ) : null}
        <Command.List className="max-h-[320px] overflow-y-auto p-1.5">
          <Command.Empty
            className="px-3 py-6 text-center text-sm"
            style={{ color: "var(--text-tertiary)" }}
          >
            No results.
          </Command.Empty>

          <Command.Group
            heading="Actions"
            className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide"
            style={{ color: "var(--text-tertiary)" }}
          >
            <PaletteItem icon={<Plus size={14} />} label="New task" shortcut="C" onSelect={() => run(() => setCreateTaskOpen(true))} />
            <PaletteItem icon={<Kanban size={14} />} label="New project" onSelect={() => run(() => setCreateProjectOpen(true))} />
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
            <PaletteItem icon={<MessageSquarePlus size={14} />} label="New agent run" shortcut="⌘J" onSelect={() => run(() => setComposerOpen(true))} />
            {CODING_AGENTS_DESKTOP_WORKSPACE ? (
              <PaletteItem icon={<Bot size={14} />} label="Open Agents" onSelect={() => run(() => openTab({ kind: "agents", title: "Agents" }))} />
            ) : null}
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
            <PaletteItem icon={<Home size={14} />} label="Go to Home" onSelect={() => run(() => openTab({ kind: "home", title: "Home", closable: false }))} />
            <PaletteItem icon={<SquareTerminal size={14} />} label="Open Terminal" onSelect={() => run(() => openTab({ kind: "terminals", title: "Terminal" }))} />
            <PaletteItem icon={<LayoutGrid size={14} />} label="Open Apps" onSelect={() => run(() => openTab({ kind: "apps", title: "Apps" }))} />
            <PaletteItem icon={<Settings size={14} />} label="Open settings" onSelect={() => run(() => openTab({ kind: "settings", title: "Settings" }))} />
          </Command.Group>

          {projects.length > 0 ? (
            <Command.Group heading="Projects" style={{ color: "var(--text-tertiary)" }}>
              {projects.slice(0, 20).map((p) => (
                <PaletteItem
                  key={p.slug}
                  icon={<Kanban size={14} />}
                  label={p.name || p.slug}
                  onSelect={() => run(() => openTab({ kind: "board", projectSlug: p.slug, title: p.name || p.slug }))}
                />
              ))}
            </Command.Group>
          ) : null}

          {cards.length > 0 ? (
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

          {reviewCommands.length > 0 ? (
            <Command.Group heading="Reviews" style={{ color: "var(--text-tertiary)" }}>
              {reviewCommands.map((review) => (
                <PaletteItem
                  key={review.id}
                  icon={<ClipboardCheck size={14} />}
                  label={`Open review PR #${review.pullRequestNumber}`}
                  onSelect={() =>
                    run(() => {
                      openTab({ kind: "agents", title: "Agents" });
                      void selectReview(review.id);
                    })
                  }
                />
              ))}
            </Command.Group>
          ) : null}

          {shellSessions.length > 0 ? (
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

          {apps.length > 0 ? (
            <Command.Group heading="Apps" style={{ color: "var(--text-tertiary)" }}>
              {apps.slice(0, 30).map((app) => (
                <PaletteItem
                  key={app.slug}
                  icon={<LayoutGrid size={14} />}
                  label={app.name}
                  onSelect={() => run(() => openTab({ kind: "app", slug: app.slug, title: app.name, ...(appIconUrl(platformHost, app.slug) ? { icon: appIconUrl(platformHost, app.slug)! } : {}) }))}
                />
              ))}
            </Command.Group>
          ) : null}

          {otherTabs.length > 0 ? (
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
    </div>
  );
}

function PaletteItem({
  icon,
  label,
  shortcut,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
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
