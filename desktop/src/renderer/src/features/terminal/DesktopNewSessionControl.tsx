import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, Plus, SquareTerminal } from "@renderer/lib/hugeicons";

import { DESKTOP_Z_INDEX } from "../../design/layering";
import {
  TERMINAL_AGENT_OPTIONS,
  terminalAgentAction,
  type TerminalAgentId,
  type TerminalAgentInstallState,
  type TerminalAgentMenuAction,
  type TerminalAgentOption,
} from "./terminal-agent-options";

export function DesktopNewSessionControl({
  disabled,
  creating,
  agentStatuses,
  checkingAgentStatuses,
  onRefreshAgentStatuses,
  onCreateShell,
  onCreateAgent,
}: {
  disabled: boolean;
  creating: boolean;
  agentStatuses: Record<TerminalAgentId, TerminalAgentInstallState>;
  checkingAgentStatuses: boolean;
  onRefreshAgentStatuses: () => void;
  onCreateShell: () => void;
  onCreateAgent: (option: TerminalAgentOption, action: TerminalAgentMenuAction) => void;
}) {
  const controlDisabled = disabled || creating;
  return (
    <div className="no-drag flex h-7 shrink-0 overflow-hidden rounded-md" style={{ background: "var(--accent)", color: "var(--text-on-accent)" }}>
      <button
        type="button"
        aria-label="New shell session"
        disabled={controlDisabled}
        className="flex w-7 items-center justify-center disabled:opacity-50"
        onClick={onCreateShell}
      >
        <Plus size={15} aria-hidden="true" />
      </button>
      <DropdownMenu.Root onOpenChange={(open) => open && onRefreshAgentStatuses()}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Choose session type"
            disabled={controlDisabled}
            className="flex w-5 items-center justify-center border-l border-white/20 disabled:opacity-50"
          >
            <ChevronDown size={11} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            aria-label="New terminal session"
            align="end"
            sideOffset={6}
            className="fade-in min-w-[210px] rounded-lg border p-1"
            style={{
              zIndex: DESKTOP_Z_INDEX.popover,
              background: "var(--bg-overlay)",
              borderColor: "var(--border-default)",
              boxShadow: "var(--shadow-2)",
              color: "var(--text-primary)",
            }}
          >
            <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--text-tertiary)" }}>
              New tab
            </DropdownMenu.Label>
            <SessionMenuItem label="Shell" icon={<SquareTerminal size={14} />} onSelect={onCreateShell} />
            {TERMINAL_AGENT_OPTIONS.map((option) => {
              const state = agentStatuses[option.id];
              const action = terminalAgentAction(state);
              const status = state === "missing"
                ? "Install"
                : state === "unknown"
                  ? checkingAgentStatuses ? "Checking…" : "Unavailable"
                  : null;
              return (
                <SessionMenuItem
                  key={option.id}
                  label={option.label}
                  badge={option.shortLabel.slice(0, 2)}
                  status={status}
                  disabled={action === null}
                  onSelect={() => action && onCreateAgent(option, action)}
                />
              );
            })}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function SessionMenuItem({
  label,
  icon,
  badge,
  status,
  disabled = false,
  onSelect,
}: {
  label: string;
  icon?: React.ReactNode;
  badge?: string;
  status?: string | null;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-[var(--bg-hover)]"
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded text-[9px] font-bold" style={{ background: "var(--bg-selected)", color: "var(--text-secondary)" }}>
        {icon ?? badge}
      </span>
      <span className="min-w-0 flex-1">{label}</span>
      {status ? <span className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>{status}</span> : null}
    </DropdownMenu.Item>
  );
}
