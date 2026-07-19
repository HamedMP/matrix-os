"use client";

import { TerminalIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, type ReactNode, type RefObject } from "react";
import { TerminalAgentLogo } from "./TerminalAgentLogo";
import {
  TERMINAL_AGENT_OPTIONS,
  resolveTerminalAgentMenuState,
  type TerminalAgentId,
  type TerminalAgentInstallState,
  type TerminalAgentMenuAction,
  type TerminalAgentOption,
} from "./terminal-agent-options";

export function NewSessionMenu({
  align,
  onClose,
  onCreateShell,
  onCreateAgent,
  agentStatuses,
  agentStatusesChecking,
  agentStatusesUnavailable,
  ignoreLightDismissRef,
}: {
  align: "left" | "right" | "mobile";
  onClose: () => void;
  onCreateShell: () => void;
  onCreateAgent: (option: TerminalAgentOption, action: TerminalAgentMenuAction) => void;
  agentStatuses: Record<TerminalAgentId, TerminalAgentInstallState>;
  agentStatusesChecking: boolean;
  agentStatusesUnavailable: boolean;
  ignoreLightDismissRef?: RefObject<HTMLElement | null>;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const closeMenu = useEffectEvent(onClose);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      if (target instanceof Node && ignoreLightDismissRef?.current?.contains(target)) return;
      closeMenu();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [ignoreLightDismissRef]);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="New session menu"
      className="terminal-new-session-menu"
      data-align={align}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      style={{
        background: "var(--terminal-drawer-card-bg)",
        border: "1px solid var(--terminal-drawer-card-border)",
        borderRadius: 9,
        boxShadow: "0 16px 36px var(--terminal-drawer-card-shadow)",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: 8,
        position: "absolute",
        transformOrigin: align === "mobile" ? "bottom left" : align === "right" ? "top right" : "top left",
        ...(align === "mobile"
          ? { bottom: "calc(100% + 8px)", left: 0 }
          : align === "right"
            ? { right: 0, top: "calc(100% + 8px)" }
            : { left: "calc(100% + 8px)", top: 0 }),
        width: 244,
        zIndex: 120,
      }}
    >
      <div style={{ padding: "0 4px 1px" }}>
        <div
          style={{
            color: "var(--terminal-drawer-subtle)",
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: "0.08em",
            lineHeight: "15px",
            textTransform: "uppercase",
          }}
        >
          NEW TAB
        </div>
      </div>
      <NewSessionMenuItem
        label="Shell"
        active
        icon={(
          <TerminalIcon
            aria-hidden="true"
            size={16}
            strokeWidth={2.1}
            style={{ color: "var(--terminal-drawer-selected-stripe)", flexShrink: 0 }}
          />
        )}
        onClick={onCreateShell}
      />
      {TERMINAL_AGENT_OPTIONS.map((option) => {
        const installState = agentStatuses[option.id];
        const menuState = resolveTerminalAgentMenuState(
          installState,
          agentStatusesChecking,
          agentStatusesUnavailable,
        );
        return (
          <NewSessionMenuItem
            key={option.id}
            label={option.label}
            statusLabel={menuState.statusLabel}
            icon={<TerminalAgentLogo agent={option.id} />}
            onClick={() => onCreateAgent(option, menuState.action)}
          />
        );
      })}
    </div>
  );
}

function NewSessionMenuItem({
  label,
  icon,
  active = false,
  statusLabel = null,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active?: boolean;
  statusLabel?: "Install" | "Checking…" | "Status unavailable" | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        alignItems: "center",
        background: active ? "var(--terminal-drawer-action-bg)" : "transparent",
        border: 0,
        borderRadius: 7,
        boxSizing: "border-box",
        color: "var(--terminal-drawer-fg)",
        cursor: "pointer",
        display: "flex",
        flexShrink: 0,
        gap: 9,
        height: 32,
        padding: "0 9px",
        textAlign: "left",
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = "var(--terminal-drawer-action-bg)";
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = active ? "var(--terminal-drawer-action-bg)" : "transparent";
      }}
    >
      {icon}
      <span
        style={{
          flex: "1 1 auto",
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 13,
          fontWeight: active ? 700 : 600,
          lineHeight: "17px",
          minWidth: 0,
          color: "var(--terminal-drawer-fg)",
        }}
      >
        {label}
      </span>
      {statusLabel ? (
        <span
          style={{
            alignItems: "center",
            display: "flex",
            flexShrink: 0,
            justifyContent: "flex-end",
          }}
        >
          <span
            data-testid={statusLabel === "Install" ? "terminal-agent-install-pill" : "terminal-agent-status-pill"}
            style={{
              alignItems: "center",
              background: "var(--terminal-drawer-action-bg)",
              border: "1px solid var(--terminal-drawer-action-border)",
              borderRadius: 999,
              boxSizing: "border-box",
              color: "var(--terminal-drawer-action-fg)",
              display: "flex",
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: statusLabel === "Status unavailable" ? 10 : 12,
              fontWeight: 700,
              height: 18,
              lineHeight: "14px",
              padding: "0 6px",
            }}
          >
            {statusLabel}
          </span>
        </span>
      ) : null}
    </button>
  );
}
