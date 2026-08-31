import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Clipboard, Edit3, MoreHorizontal, SquareTerminal, Trash2, X } from "@renderer/lib/hugeicons";

import { DESKTOP_Z_INDEX } from "../../design/layering";
import type { ShellSessionSummary } from "../../stores/shell-sessions";
import { OSWindowSafeView } from "../desktop-shell/OSWindow";
import { DesktopNewSessionControl } from "./DesktopNewSessionControl";
import { relativeSessionActivity } from "./terminal-session-activity";
import {
  terminalAgentLabel,
  UNKNOWN_TERMINAL_AGENT_STATUSES,
  type TerminalAgentId,
  type TerminalAgentInstallState,
  type TerminalAgentMenuAction,
  type TerminalAgentOption,
} from "./terminal-agent-options";

function isActive(shell: ShellSessionSummary): boolean {
  return shell.status === "active" || shell.visualStatus === "running";
}

function displayName(shell: ShellSessionSummary): string {
  return shell.subtitle?.trim() || shell.tabId || shell.name;
}

function agentMetadata(shell: ShellSessionSummary): string | null {
  if (!shell.agent) return null;
  return [terminalAgentLabel(shell.agent), shell.model, shell.strength, shell.lastAction ?? shell.subtitle]
    .filter(Boolean)
    .join(" · ");
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
  onDelete: (session: ShellSessionSummary) => void;
}) {
  return (
    <OSWindowSafeView area="sidebar" data-terminal-session-sidebar className="flex h-full min-h-0 w-full flex-col">
      <aside className="flex h-full min-h-0 w-full flex-col">
        <div className="flex min-h-12 shrink-0 items-center justify-between border-b px-4 py-2" style={{ borderColor: "var(--border-subtle)" }}>
          <div className="flex min-w-0 items-center gap-1.5">
            <SquareTerminal size={16} aria-hidden="true" />
            <h1 className="truncate text-base font-medium tracking-[-0.4px]" style={{ color: "var(--text-primary)" }}>Terminal</h1>
          </div>
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
        <ul aria-label="Terminal sessions" className="min-h-0 flex-1 overflow-y-auto pb-4">
          {sessions.map((session) => {
            const label = displayName(session);
            const selected = selectedName === session.name;
            const metadata = agentMetadata(session);
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
                      aria-label={`Open ${label}`}
                      aria-current={selected || undefined}
                      className="flex min-h-16 w-full min-w-0 items-start gap-2 px-4 py-3 pr-10 text-left hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
                      style={{ background: selected ? "var(--bg-hover)" : "transparent" }}
                      onClick={() => onSelect(session)}
                    >
                      <span
                        data-terminal-session-status={isActive(session) ? "active" : "inactive"}
                        className="mt-1.5 size-2.5 shrink-0 rounded-full"
                        style={{ background: isActive(session) ? "var(--success)" : "var(--text-tertiary)" }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center justify-between gap-2">
                          <span className="truncate text-sm leading-5" style={{ color: "var(--text-primary)" }}>{label}</span>
                          <span className="shrink-0 text-[10px]" style={{ color: "var(--text-tertiary)" }}>{relativeSessionActivity(session.updatedAt)}</span>
                        </span>
                        {metadata ? <span className="mt-0.5 block truncate text-[10px] leading-4" style={{ color: "var(--text-secondary)" }}>{metadata}</span> : null}
                      </span>
                    </button>
                    <SessionActions
                      session={session}
                      disabled={disabled}
                      onRename={() => onRename(session)}
                      onCopy={() => onCopyConnectCommand(session)}
                      onDelete={() => onDelete(session)}
                    />
                    <button
                      type="button"
                      aria-label={`Delete ${label}`}
                      disabled={disabled}
                      className="absolute right-9 top-3 z-10 flex size-7 items-center justify-center rounded-md bg-[var(--bg-surface)] text-[var(--text-tertiary)] opacity-0 transition-opacity hover:bg-[var(--bg-hover)] hover:text-[var(--danger)] focus-visible:opacity-100 group-hover/session:opacity-100"
                      onClick={() => onDelete(session)}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
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

function SessionActions({ session, disabled, onRename, onCopy, onDelete }: {
  session: ShellSessionSummary;
  disabled: boolean;
  onRename: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`More actions for ${displayName(session)}`}
          disabled={disabled}
          className="absolute right-2 top-3 z-10 flex size-7 items-center justify-center rounded-md bg-[var(--bg-surface)] text-[var(--text-tertiary)] opacity-0 transition-opacity hover:bg-[var(--bg-active)] focus-visible:opacity-100 group-hover/session:opacity-100"
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label={`Actions for ${displayName(session)}`}
          align="end"
          sideOffset={5}
          className="fade-in min-w-[200px] rounded-lg border p-1"
          style={{ zIndex: DESKTOP_Z_INDEX.popover, background: "var(--bg-overlay)", borderColor: "var(--border-default)", boxShadow: "var(--shadow-2)" }}
        >
          <SessionAction icon={<Edit3 size={13} />} label="Rename" onSelect={onRename} />
          <SessionAction icon={<Clipboard size={13} />} label="Copy connect command" onSelect={onCopy} />
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
