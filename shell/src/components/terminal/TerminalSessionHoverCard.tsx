"use client";

import { useEffect, useState, type CSSProperties, type ReactElement, type RefObject } from "react";
import { HoverCard as HoverCardPrimitive } from "radix-ui";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { TerminalAgentLogo } from "./TerminalAgentLogo";
import { getShellVisualStatus, type ShellSessionSummary } from "./terminal-session-state";
import { TERMINAL_MONO_FONT_FAMILY, TERMINAL_UI_FONT_FAMILY } from "./terminal-typography";

const HOVER_CARD_WIDTH = 288;
const HOVER_CARD_GAP = 12;

interface TerminalHoverCardTheme {
  background: string;
  border: string;
  foreground: string;
  muted: string;
  shadow: string;
  subtle: string;
}

const FALLBACK_HOVER_CARD_THEME: TerminalHoverCardTheme = {
  background: "#1c2019",
  border: "rgba(240, 239, 229, 0.16)",
  foreground: "#f0efe5",
  muted: "#a4a69a",
  shadow: "rgba(0, 0, 0, 0.42)",
  subtle: "#7d8176",
};

const HOVER_CARD_BASE_STYLE: CSSProperties = {
  borderRadius: 8,
  display: "grid",
  fontFamily: TERMINAL_UI_FONT_FAMILY,
  gap: 12,
  maxHeight: "calc(100vh - 24px)",
  maxWidth: "calc(100vw - 24px)",
  overflow: "auto",
  padding: 14,
  width: HOVER_CARD_WIDTH,
  zIndex: SHELL_Z_INDEX.popover,
};

function readHoverCardTheme(card: HTMLElement | null): TerminalHoverCardTheme {
  if (!card || typeof window === "undefined") return FALLBACK_HOVER_CARD_THEME;
  const style = window.getComputedStyle(card);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: read("--terminal-drawer-card-bg", FALLBACK_HOVER_CARD_THEME.background),
    border: read("--terminal-drawer-card-border", FALLBACK_HOVER_CARD_THEME.border),
    foreground: read("--terminal-drawer-fg", FALLBACK_HOVER_CARD_THEME.foreground),
    muted: read("--terminal-drawer-muted", FALLBACK_HOVER_CARD_THEME.muted),
    shadow: read("--terminal-drawer-card-shadow", FALLBACK_HOVER_CARD_THEME.shadow),
    subtle: read("--terminal-drawer-subtle", FALLBACK_HOVER_CARD_THEME.subtle),
  };
}

export function formatTerminalAgentName(agent: NonNullable<ShellSessionSummary["agent"]>): string {
  if (agent === "claude") return "Claude";
  if (agent === "codex") return "Codex";
  if (agent === "opencode") return "OpenCode";
  return "Pi";
}

export function formatAgentStrength(strength: string): string {
  if (strength.toLowerCase() === "xhigh") return "XHigh";
  return `${strength.charAt(0).toUpperCase()}${strength.slice(1).toLowerCase()}`;
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
  return card.getBoundingClientRect().right + HOVER_CARD_GAP + HOVER_CARD_WIDTH <= window.innerWidth - 12;
}

function safePullRequestUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" ? url.toString() : null;
  } catch (err: unknown) {
    if (!(err instanceof TypeError)) {
      console.warn("Failed to validate terminal pull request URL");
    }
    return null;
  }
}

function ContextField({
  label,
  value,
  theme,
}: {
  label: string;
  value: string;
  theme: TerminalHoverCardTheme;
}) {
  return (
    <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
      <span style={{ color: theme.subtle, fontSize: 10, fontWeight: 750 }}>{label}</span>
      <span style={{ fontFamily: TERMINAL_MONO_FONT_FAMILY, fontSize: 11, overflowWrap: "anywhere" }}>
        {value}
      </span>
    </div>
  );
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
  shell: ShellSessionSummary;
  displayName: string;
  cardRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  suppressed: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactElement;
}) {
  const [theme, setTheme] = useState(FALLBACK_HOVER_CARD_THEME);
  const agentName = shell.agent ? formatTerminalAgentName(shell.agent) : "Terminal";
  const liveState = getShellVisualStatus(shell);
  const updatedAt = shell.agent ? shell.agentUpdatedAt : shell.updatedAt;
  const pullRequestUrl = safePullRequestUrl(shell.pullRequest?.url);
  const hasProjectContext = Boolean(shell.project || shell.repository || shell.branch || shell.pullRequest);
  const canDisplay = open && !suppressed && canOpenToRight(cardRef.current);
  useEffect(() => {
    if (canDisplay) setTheme(readHoverCardTheme(cardRef.current));
  }, [canDisplay, cardRef]);
  return (
    <HoverCardPrimitive.Root
      open={canDisplay}
      onOpenChange={(nextOpen) => {
        const canOpen = nextOpen && canOpenToRight(cardRef.current);
        if (canOpen) setTheme(readHoverCardTheme(cardRef.current));
        onOpenChange(canOpen);
      }}
      openDelay={300}
      closeDelay={100}
    >
      <HoverCardPrimitive.Trigger asChild>{children}</HoverCardPrimitive.Trigger>
      <HoverCardPrimitive.Portal>
        <HoverCardPrimitive.Content
          data-testid={`terminal-session-hover-card-${shell.name}`}
          aria-label={`${shell.agent ? "Agent" : "Session"} details for ${displayName}`}
          side="right"
          align="start"
          sideOffset={HOVER_CARD_GAP}
          collisionPadding={12}
          avoidCollisions={false}
          onPointerDown={(event) => event.stopPropagation()}
          style={{
            ...HOVER_CARD_BASE_STYLE,
            background: theme.background,
            border: `1px solid ${theme.border}`,
            boxShadow: `0 18px 42px ${theme.shadow}`,
            color: theme.foreground,
          }}
        >
          <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", gap: 12 }}>
            <div style={{ alignItems: "center", display: "flex", gap: 7, minWidth: 0 }}>
              {shell.agent ? (
                <TerminalAgentLogo
                  agent={shell.agent}
                  testIdPrefix="terminal-session-hover-agent-logo"
                />
              ) : null}
              <strong style={{ fontSize: 12, fontWeight: 600 }}>{agentName}</strong>
            </div>
            <span style={{ color: theme.muted, fontSize: 11, textTransform: "capitalize" }}>
              {liveState}
            </span>
          </div>
          {shell.model || shell.strength ? (
            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
              {shell.model ? (
                <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
                  <span style={{ color: theme.subtle, fontSize: 10, fontWeight: 750 }}>Model</span>
                  <span style={{ fontFamily: TERMINAL_MONO_FONT_FAMILY, fontSize: 11, overflowWrap: "anywhere" }}>
                    {shell.model}
                  </span>
                </div>
              ) : null}
              {shell.strength ? (
                <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
                  <span style={{ color: theme.subtle, fontSize: 10, fontWeight: 750 }}>Strength</span>
                  <span style={{ fontSize: 12 }}>
                    {formatAgentStrength(shell.strength)}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
          {shell.subtitle ? (
            <p style={{ fontSize: 12, lineHeight: "18px", margin: 0, overflowWrap: "anywhere" }}>
              {shell.subtitle}
            </p>
          ) : null}
          {hasProjectContext ? (
            <div data-testid={`terminal-session-project-context-${shell.name}`} style={{ display: "grid", gap: 9 }}>
              {shell.project ? <ContextField label="Project" value={shell.project} theme={theme} /> : null}
              {shell.repository ? <ContextField label="Repository" value={shell.repository} theme={theme} /> : null}
              {shell.branch ? <ContextField label="Branch" value={shell.branch} theme={theme} /> : null}
              {shell.pullRequest ? (
                <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
                  <span style={{ color: theme.subtle, fontSize: 10, fontWeight: 750 }}>Pull request</span>
                  {pullRequestUrl ? (
                    <a
                      href={pullRequestUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: theme.foreground, fontFamily: TERMINAL_MONO_FONT_FAMILY, fontSize: 11 }}
                    >
                      PR #{shell.pullRequest.number}
                    </a>
                  ) : (
                    <span style={{ fontFamily: TERMINAL_MONO_FONT_FAMILY, fontSize: 11 }}>
                      PR #{shell.pullRequest.number}
                    </span>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
          {!shell.agent ? (
            <div style={{ display: "grid", gap: 3 }}>
              <span style={{ color: theme.subtle, fontSize: 10, fontWeight: 750 }}>Shell status</span>
              <span style={{ fontSize: 12, textTransform: "capitalize" }}>
                {shell.status ?? "active"}
              </span>
            </div>
          ) : shell.lastAction ? (
            <div style={{ display: "grid", gap: 3 }}>
              <span style={{ color: theme.subtle, fontSize: 10, fontWeight: 750 }}>Last action</span>
              <span style={{ fontSize: 12, lineHeight: "17px", overflowWrap: "anywhere" }}>
                {shell.lastAction}
              </span>
            </div>
          ) : null}
          <time
            dateTime={updatedAt}
            style={{ color: theme.subtle, fontSize: 10 }}
          >
            {formatAgentUpdatedAt(updatedAt)}
          </time>
        </HoverCardPrimitive.Content>
      </HoverCardPrimitive.Portal>
    </HoverCardPrimitive.Root>
  );
}
