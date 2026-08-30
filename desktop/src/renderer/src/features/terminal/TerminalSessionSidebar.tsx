import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Clipboard, Edit3, Folder, MoreHorizontal, PinIcon, PinOffIcon, SquareTerminal, Trash2, X } from "@renderer/lib/hugeicons";
import { useState } from "react";

import { DESKTOP_Z_INDEX } from "../../design/layering";
import type { ShellSessionSummary } from "../../stores/shell-sessions";
import { OSWindowSafeView } from "../desktop-shell/OSWindow";
import { DesktopNewSessionControl } from "./DesktopNewSessionControl";
import { DesktopTerminalThemePicker } from "./DesktopTerminalThemePicker";
import { relativeSessionActivity } from "./terminal-session-activity";
import {
  terminalAgentLabel,
  UNKNOWN_TERMINAL_AGENT_STATUSES,
  type TerminalAgentId,
  type TerminalAgentInstallState,
  type TerminalAgentMenuAction,
  type TerminalAgentOption,
} from "./terminal-agent-options";
import { DesktopTerminalAgentLogo } from "./DesktopTerminalAgentLogo";

function agentMetadata(shell: ShellSessionSummary): string | null {
  if (!shell.agent) return null;
  return [terminalAgentLabel(shell.agent), shell.model, shell.strength]
    .filter(Boolean)
    .join(" · ");
}

function displayCwd(cwd: string): string {
  return cwd === "~" ? cwd : `~/${cwd}`;
}

function sessionTitle(shell: ShellSessionSummary): string {
  return shell.subtitle?.trim() || shell.name;
}

export function TerminalSessionSidebar({
  sessions,
  selectedName,
  creating,
  disabled,
  agentStatuses = UNKNOWN_TERMINAL_AGENT_STATUSES,
  checkingAgentStatuses = false,
  renamingName,
  renameDraft,
  renameError,
  onCreate,
  onCreateAgent,
  onRefreshAgentStatuses,
  onSelect,
  onRename,
  onRenameDraft,
  onCommitRename,
  onCancelRename,
  onCopyConnectCommand,
  onPin,
  onDelete,
}: {
  sessions: ShellSessionSummary[];
  selectedName: string | null;
  creating: boolean;
  disabled: boolean;
  agentStatuses: Record<TerminalAgentId, TerminalAgentInstallState>;
  checkingAgentStatuses: boolean;
  renamingName: string | null;
  renameDraft: string;
  renameError: string | null;
  onCreate: () => void;
  onCreateAgent: (option: TerminalAgentOption, action: TerminalAgentMenuAction) => void;
  onRefreshAgentStatuses: () => void;
  onSelect: (session: ShellSessionSummary) => void;
  onRename: (session: ShellSessionSummary) => void;
  onRenameDraft: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onCopyConnectCommand: (session: ShellSessionSummary) => void;
  onPin: (session: ShellSessionSummary, pinned: boolean) => void;
  onDelete: (session: ShellSessionSummary) => void;
}) {
  const [actionsName, setActionsName] = useState<string | null>(null);
  return (
    <OSWindowSafeView area="sidebar" data-terminal-session-sidebar className="flex h-full min-h-0 w-full flex-col">
      <aside className="flex h-full min-h-0 w-full flex-col">
        <div className="flex min-h-12 shrink-0 items-center justify-between border-b px-4 py-2" style={{ borderColor: "var(--border-subtle)" }}>
          <div className="flex min-w-0 items-center gap-1.5">
            <SquareTerminal size={16} aria-hidden="true" />
            <h1 className="truncate text-base font-medium tracking-[-0.4px]" style={{ color: "var(--text-primary)" }}>Terminal</h1>
          </div>
          <div data-terminal-sidebar-header-actions className="no-drag flex shrink-0 items-center gap-2">
            <DesktopTerminalThemePicker />
            <DesktopNewSessionControl
              disabled={disabled}
              creating={creating}
              agentStatuses={agentStatuses}
              checkingAgentStatuses={checkingAgentStatuses}
              onRefreshAgentStatuses={onRefreshAgentStatuses}
              onCreateShell={onCreate}
              onCreateAgent={onCreateAgent}
            />
          </div>
        </div>
        <ul aria-label="Terminal sessions" className="min-h-0 flex-1 overflow-y-auto pb-4">
          {[...sessions].sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))).map((session) => {
            const selected = selectedName === session.name;
            const metadata = agentMetadata(session);
            const title = sessionTitle(session);
            const renaming = renamingName === session.name;
            return (
              <li key={session.name} className="group/session relative shrink-0 border-b" style={{ borderColor: "var(--border-subtle)" }}>
                {renaming ? (
                  <div className="flex min-h-16 flex-col justify-center gap-1 px-3 py-2">
                    <div className="flex items-center gap-1">
                      <input
                        autoFocus
                        aria-label="Terminal session name"
                        value={renameDraft}
                        disabled={disabled}
                        className="h-7 min-w-0 flex-1 rounded-md border bg-transparent px-2 font-mono text-xs outline-none focus:ring-1 focus:ring-[var(--accent)]"
                        style={{ borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
                        onChange={(event) => onRenameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") onCommitRename();
                          if (event.key === "Escape") onCancelRename();
                        }}
                      />
                      <button type="button" aria-label="Save terminal session name" className="flex size-7 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]" onClick={onCommitRename}>
                        <Check size={13} />
                      </button>
                      <button type="button" aria-label="Cancel terminal session rename" className="flex size-7 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]" onClick={onCancelRename}>
                        <X size={13} />
                      </button>
                    </div>
                    {renameError ? <span className="text-[10px]" style={{ color: "var(--danger)" }}>{renameError}</span> : null}
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      aria-label={`Open ${session.name}`}
                      aria-current={selected || undefined}
                      className="flex min-h-16 w-full min-w-0 items-start px-4 py-3 pr-10 text-left hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
                      style={{ background: selected ? "var(--bg-hover)" : "transparent" }}
                      onClick={() => onSelect(session)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setActionsName(session.name);
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center justify-between gap-2">
                          <span
                            data-testid={`terminal-session-title-${session.name}`}
                            className="truncate text-sm leading-5"
                            style={{ color: "var(--text-primary)" }}
                            onDoubleClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              onRename(session);
                            }}
                          >
                            {title}
                          </span>
                          <span className="flex shrink-0 items-center gap-1 text-[10px]" style={{ color: "var(--text-tertiary)" }}>
                            {session.pinned ? <PinIcon size={11} aria-label="Pinned" /> : null}
                            {relativeSessionActivity(session.updatedAt)}
                          </span>
                        </span>
                        {session.cwd || (metadata && session.agent) ? (
                          <span
                            data-testid={`terminal-session-agent-metadata-${session.name}`}
                            className="mt-0.5 flex min-w-0 items-center justify-between gap-2 text-[10px] leading-4"
                            style={{ color: "var(--text-secondary)" }}
                          >
                            <span
                              data-testid={`terminal-session-path-${session.name}`}
                              className="flex min-w-0 items-center gap-1.5"
                            >
                              {session.cwd ? <Folder size={13} className="shrink-0" aria-hidden="true" /> : null}
                              {session.cwd ? <span className="min-w-0 truncate font-mono">{displayCwd(session.cwd)}</span> : null}
                            </span>
                            {session.agent ? (
                              <span
                                data-testid={`terminal-session-agent-${session.name}`}
                                className="flex min-w-0 shrink-0 items-center gap-1.5"
                              >
                                <DesktopTerminalAgentLogo
                                  agent={session.agent}
                                  compact
                                  testIdPrefix="desktop-terminal-session-agent-logo"
                                />
                                {metadata ? <span className="max-w-28 truncate">{metadata}</span> : null}
                              </span>
                            ) : null}
                          </span>
                        ) : null}
                      </span>
                    </button>
                    <SessionActions
                      session={session}
                      disabled={disabled}
                      open={actionsName === session.name}
                      onOpenChange={(open) => setActionsName(open ? session.name : null)}
                      onRename={() => onRename(session)}
                      onCopy={() => onCopyConnectCommand(session)}
                      onPin={() => onPin(session, !session.pinned)}
                      onDelete={() => onDelete(session)}
                    />
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </aside>
    </OSWindowSafeView>
  );
}

function SessionActions({ session, disabled, open, onOpenChange, onRename, onCopy, onPin, onDelete }: {
  session: ShellSessionSummary;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: () => void;
  onCopy: () => void;
  onPin: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`More actions for ${session.name}`}
          disabled={disabled}
          className="absolute right-2 top-3 z-10 flex size-7 items-center justify-center rounded-md bg-[var(--bg-surface)] text-[var(--text-tertiary)] opacity-0 transition-opacity hover:bg-[var(--bg-active)] focus-visible:opacity-100 group-hover/session:opacity-100"
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label={`Actions for ${session.name}`}
          align="end"
          sideOffset={5}
          className="fade-in min-w-[200px] rounded-lg border p-1"
          style={{ zIndex: DESKTOP_Z_INDEX.popover, background: "var(--bg-overlay)", borderColor: "var(--border-default)", boxShadow: "var(--shadow-2)" }}
        >
          <SessionAction icon={<Edit3 size={13} />} label="Rename" onSelect={onRename} />
          <SessionAction icon={<Clipboard size={13} />} label="Copy connect command" onSelect={onCopy} />
          <SessionAction
            icon={session.pinned ? <PinOffIcon size={13} /> : <PinIcon size={13} />}
            label={session.pinned ? "Unpin" : "Pin"}
            onSelect={onPin}
          />
          <DropdownMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle)" }} />
          <SessionAction icon={<Trash2 size={13} />} label="Delete" danger onSelect={onDelete} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function SessionAction({ icon, label, danger = false, onSelect }: { icon: React.ReactNode; label: string; danger?: boolean; onSelect: () => void }) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-[var(--bg-hover)]"
      style={{ color: danger ? "var(--danger)" : "var(--text-primary)" }}
    >
      {icon}
      {label}
    </DropdownMenu.Item>
  );
}
