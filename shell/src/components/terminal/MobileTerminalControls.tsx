import { useRef, useState, type ReactNode } from "react";
import { ClipboardPasteIcon, PlusIcon, SearchIcon } from "lucide-react";

import { getGatewayUrl } from "@/lib/gateway";
import { NewSessionMenu } from "./NewSessionMenu";
import { TERMINAL_INPUT_EVENT, type TerminalInputEventDetail } from "./terminal-input-event";
import { useTerminalAppContext } from "./TerminalAppContext";
import {
  parseTerminalAgentStatuses,
  terminalAgentVisibleInstallCommand,
  type TerminalAgentId,
  type TerminalAgentOption,
} from "./terminal-agent-options";

function dispatchPaneAction(paneId: string | null, action: NonNullable<TerminalInputEventDetail["action"]>): void {
  if (!paneId) return;
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<TerminalInputEventDetail>(TERMINAL_INPUT_EVENT, {
      detail: { paneId, action },
    }),
  );
}

export function MobileTerminalActions({
  defaultCwd,
  background,
  foreground,
  accent,
}: {
  defaultCwd: string;
  background: string;
  foreground: string;
  accent: string;
}) {
  const ctx = useTerminalAppContext();
  const [newSessionMenuOpen, setNewSessionMenuOpen] = useState(false);
  const [agentStatuses, setAgentStatuses] = useState<Record<TerminalAgentId, boolean> | null>(null);
  const newSessionDisclosureRef = useRef<HTMLDivElement | null>(null);
  const getCwd = () => ctx.sidebarSelectedPath ?? defaultCwd;
  const focusedPaneId = ctx.focusedPaneId;
  const actionBackground = `color-mix(in srgb, ${foreground} 9%, transparent)`;
  const actionBorder = `color-mix(in srgb, ${foreground} 18%, transparent)`;
  const primaryForeground = "var(--terminal-mobile-primary-fg)";

  const fetchAgentStatuses = async () => {
    try {
      const res = await fetch(`${getGatewayUrl()}/api/agents`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return;
      const parsed = parseTerminalAgentStatuses(await res.json());
      if (parsed.length === 0) return;
      setAgentStatuses(Object.fromEntries(
        parsed.map((agent) => [agent.id, agent.installed]),
      ) as Record<TerminalAgentId, boolean>);
    } catch (err: unknown) {
      console.warn("Failed to load terminal agent status:", err instanceof Error ? err.message : String(err));
    }
  };

  const toggleNewSessionMenu = () => {
    const shouldOpen = !newSessionMenuOpen;
    setNewSessionMenuOpen(shouldOpen);
    if (shouldOpen) {
      setAgentStatuses(null);
      void fetchAgentStatuses();
    }
  };

  const closeNewSessionMenu = () => {
    setNewSessionMenuOpen(false);
  };

  const createShellSession = () => {
    setNewSessionMenuOpen(false);
    void ctx.createShellSessionTab("Shell", getCwd());
  };

  const createAgentSession = (option: TerminalAgentOption, installed: boolean) => {
    setNewSessionMenuOpen(false);
    const label = installed ? option.label : `Install ${option.label}`;
    const cmd = installed
      ? option.launchCommand ?? (option.claudeMode ? "claude" : undefined)
      : terminalAgentVisibleInstallCommand(option);
    void ctx.createShellSessionTab(label, getCwd(), {
      namePrefix: option.id,
      cmd,
    });
  };

  return (
    <div
      data-testid="terminal-mobile-actions"
      role="toolbar"
      aria-label="Mobile terminal actions"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        overflow: "visible",
        padding: "6px 2px 4px",
        position: "relative",
        background,
        borderTop: `1px solid ${actionBorder}`,
        scrollbarWidth: "none",
        WebkitOverflowScrolling: "touch",
        flexShrink: 0,
      }}
    >
      <div ref={newSessionDisclosureRef} style={{ position: "relative", flex: "0 0 auto" }}>
        <MobileActionButton
          label="+ Session"
          ariaLabel="New session"
          ariaHasPopup="menu"
          ariaExpanded={newSessionMenuOpen}
          title="New session"
          icon={<PlusIcon size={14} strokeWidth={1.8} />}
          onClick={toggleNewSessionMenu}
          background={accent}
          foreground={primaryForeground}
          border="transparent"
          minWidth={92}
        />
        {newSessionMenuOpen ? (
          <NewSessionMenu
            align="mobile"
            onClose={closeNewSessionMenu}
            onCreateShell={createShellSession}
            onCreateAgent={createAgentSession}
            agentStatuses={agentStatuses}
            ignoreLightDismissRef={newSessionDisclosureRef}
          />
        ) : null}
      </div>
      <MobileActionButton
        label="Paste"
        title="Paste clipboard"
        icon={<ClipboardPasteIcon size={14} strokeWidth={1.8} />}
        onClick={() => dispatchPaneAction(focusedPaneId, "paste")}
        background={actionBackground}
        foreground={foreground}
        border={actionBorder}
        minWidth={62}
      />
      <MobileActionButton
        label="Search"
        title="Search terminal"
        icon={<SearchIcon size={14} strokeWidth={1.8} />}
        onClick={() => dispatchPaneAction(focusedPaneId, "search")}
        background={actionBackground}
        foreground={foreground}
        border={actionBorder}
        minWidth={66}
      />
    </div>
  );
}

function MobileActionButton({
  label,
  ariaLabel,
  ariaHasPopup,
  ariaExpanded,
  title,
  icon,
  onClick,
  background,
  foreground,
  border,
  minWidth = 56,
}: {
  label: string;
  ariaLabel?: string;
  ariaHasPopup?: "menu";
  ariaExpanded?: boolean;
  title: string;
  icon: ReactNode;
  onClick: () => void;
  background: string;
  foreground: string;
  border: string;
  minWidth?: number;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel ?? label}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      title={title}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        height: 32,
        minWidth,
        padding: "0 5px",
        borderRadius: 7,
        border: `1px solid ${border}`,
        background,
        color: foreground,
        fontSize: 11,
        fontWeight: 650,
        whiteSpace: "nowrap",
        flex: "0 0 auto",
        touchAction: "manipulation",
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function MobileCommandComposer({
  onSend,
  background,
  foreground,
  accent,
  onFocusChange,
}: {
  onSend: (data: string) => void;
  background: string;
  foreground: string;
  accent: string;
  onFocusChange?: (active: boolean) => void;
}) {
  const [value, setValue] = useState("");
  const submit = () => {
    const command = value.trim();
    if (!command) return;
    onSend(`${command}\r`);
    setValue("");
  };
  const border = `color-mix(in srgb, ${foreground} 18%, transparent)`;
  return (
    <form
      aria-label="Mobile command composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      style={{
        alignItems: "center",
        background,
        borderTop: `1px solid ${border}`,
        display: "flex",
        flexShrink: 0,
        gap: 7,
        padding: "8px 7px",
      }}
    >
      <input
        aria-label="Command composer"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Type command..."
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        enterKeyHint="send"
        spellCheck={false}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
        style={{
          background: `color-mix(in srgb, ${foreground} 8%, transparent)`,
          border: `1px solid ${border}`,
          borderRadius: 9,
          color: foreground,
          flex: "1 1 auto",
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
          fontSize: 16,
          height: 36,
          minWidth: 0,
          padding: "0 10px",
        }}
      />
      <button
        type="submit"
        aria-label="Send command"
        style={{
          background: accent,
          border: "1px solid transparent",
          borderRadius: 9,
          color: "var(--terminal-mobile-primary-fg)",
          cursor: "pointer",
          flexShrink: 0,
          fontSize: 12,
          fontWeight: 800,
          height: 36,
          padding: "0 13px",
        }}
      >
        Send
      </button>
    </form>
  );
}
