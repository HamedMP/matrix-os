"use client";

import type { CSSProperties, ReactElement, RefObject } from "react";
import { HoverCard as HoverCardPrimitive } from "radix-ui";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { getShellVisualStatus, type ShellSessionSummary } from "./terminal-session-state";

const HOVER_CARD_WIDTH = 288;
const HOVER_CARD_GAP = 12;

const HOVER_CARD_STYLE: CSSProperties = {
  background: "var(--terminal-drawer-card-bg)",
  border: "1px solid var(--terminal-drawer-card-border)",
  borderRadius: 8,
  boxShadow: "0 18px 42px var(--terminal-drawer-card-shadow)",
  color: "var(--terminal-drawer-fg)",
  display: "grid",
  gap: 12,
  maxHeight: "calc(100vh - 24px)",
  maxWidth: "calc(100vw - 24px)",
  overflow: "auto",
  padding: 14,
  width: HOVER_CARD_WIDTH,
  zIndex: SHELL_Z_INDEX.popover,
};

export function formatTerminalAgentName(agent: NonNullable<ShellSessionSummary["agent"]>): string {
  if (agent === "claude") return "Claude";
  if (agent === "codex") return "Codex";
  if (agent === "opencode") return "OpenCode";
  return "Pi";
}

function formatAgentUpdatedAt(value: string | undefined): string {
  if (!value) return "Updated recently";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Updated recently";
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) return "Updated just now";
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `Updated ${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `Updated ${elapsedHours}h ago`;
  return `Updated ${Math.floor(elapsedHours / 24)}d ago`;
}

function canOpenToRight(card: HTMLElement | null): boolean {
  if (!card || typeof window === "undefined") return false;
  if (!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) return false;
  return card.getBoundingClientRect().right + HOVER_CARD_GAP + HOVER_CARD_WIDTH <= window.innerWidth - 12;
}

export function TerminalSessionHoverCard({
  shell,
  displayName,
  cardRef,
  open,
  suppressed,
  onOpenChange,
  children,
}: {
  shell: ShellSessionSummary & { agent: NonNullable<ShellSessionSummary["agent"]> };
  displayName: string;
  cardRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  suppressed: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactElement;
}) {
  const agentName = formatTerminalAgentName(shell.agent);
  const liveState = getShellVisualStatus(shell);
  return (
    <HoverCardPrimitive.Root
      open={open && !suppressed}
      onOpenChange={(nextOpen) => onOpenChange(nextOpen && canOpenToRight(cardRef.current))}
      openDelay={300}
      closeDelay={100}
    >
      <HoverCardPrimitive.Trigger asChild>{children}</HoverCardPrimitive.Trigger>
      <HoverCardPrimitive.Portal>
        <HoverCardPrimitive.Content
          data-testid={`terminal-session-hover-card-${shell.name}`}
          aria-label={`Agent details for ${displayName}`}
          side="right"
          align="start"
          sideOffset={HOVER_CARD_GAP}
          collisionPadding={12}
          avoidCollisions={false}
          onPointerDown={(event) => event.stopPropagation()}
          style={HOVER_CARD_STYLE}
        >
          <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", gap: 12 }}>
            <strong style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: 12 }}>{agentName}</strong>
            <span style={{ color: "var(--terminal-drawer-muted)", fontSize: 11, textTransform: "capitalize" }}>
              {liveState}
            </span>
          </div>
          {shell.subtitle ? (
            <p style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: 12, lineHeight: "18px", margin: 0, overflowWrap: "anywhere" }}>
              {shell.subtitle}
            </p>
          ) : null}
          {shell.lastAction ? (
            <div style={{ display: "grid", gap: 3 }}>
              <span style={{ color: "var(--terminal-drawer-subtle)", fontSize: 10, fontWeight: 750 }}>Last action</span>
              <span style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: 12, lineHeight: "17px", overflowWrap: "anywhere" }}>
                {shell.lastAction}
              </span>
            </div>
          ) : null}
          <time
            dateTime={shell.agentUpdatedAt}
            style={{ color: "var(--terminal-drawer-subtle)", fontFamily: "Inter, system-ui, sans-serif", fontSize: 10 }}
          >
            {formatAgentUpdatedAt(shell.agentUpdatedAt)}
          </time>
        </HoverCardPrimitive.Content>
      </HoverCardPrimitive.Portal>
    </HoverCardPrimitive.Root>
  );
}
