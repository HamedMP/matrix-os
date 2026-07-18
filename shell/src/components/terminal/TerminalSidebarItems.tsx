"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import {
  CheckIcon,
  ChevronRightIcon,
  ChevronsRightIcon,
  GripVerticalIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Rows2Icon,
  Trash2Icon,
} from "lucide-react";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { sessionAccent } from "./terminal-session-names";
import { NewSessionMenu } from "./NewSessionMenu";
import type { TerminalAgentId, TerminalAgentOption } from "./terminal-agent-options";
import type { ShellSessionSummary } from "./terminal-session-state";
import { formatTerminalAgentName, TerminalSessionHoverCard } from "./TerminalSessionHoverCard";

export const DEFAULT_SHELL_SESSION_NAME = "main";

const COLLAPSED_RAIL_ITEM_SIZE = 40;

const SHELL_ROW_BUTTON_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  borderRadius: 10,
  cursor: "pointer",
  inset: 0,
  padding: 0,
  position: "absolute",
  zIndex: 0,
};

const SHELL_ROW_DRAG_HANDLE_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--terminal-drawer-subtle)",
  flexShrink: 0,
  height: 18,
  padding: 0,
  pointerEvents: "auto",
  transition: "opacity 120ms ease",
  width: 12,
};

const SESSION_ACTIONS_STYLE: CSSProperties = {
  flexDirection: "row-reverse",
  gap: 6,
  position: "absolute",
  right: 8,
  top: "50%",
  transform: "translateY(-50%)",
  transition: "opacity 120ms ease",
  justifyContent: "flex-end",
};

const SESSION_RENAME_BUTTON_STYLE: CSSProperties = {
  background: "var(--terminal-drawer-action-bg)",
  border: "1px solid var(--terminal-drawer-action-border)",
  borderRadius: 6,
  color: "var(--terminal-drawer-action-fg)",
  flexShrink: 0,
  height: 22,
  pointerEvents: "auto",
  transition: "opacity 120ms ease",
  width: 22,
};

const SESSION_MORE_BUTTON_STYLE: CSSProperties = {
  background: "var(--terminal-drawer-action-bg)",
  border: "1px solid var(--terminal-drawer-action-border)",
  borderRadius: 6,
  color: "var(--terminal-drawer-action-fg)",
  cursor: "pointer",
  flexShrink: 0,
  height: 24,
  pointerEvents: "auto",
  position: "relative",
  transition: "opacity 120ms ease",
  width: 24,
};

const SESSION_CONTEXT_MENU_STYLE: CSSProperties = {
  background: "var(--terminal-drawer-card-bg)",
  border: "1px solid var(--terminal-drawer-card-border)",
  borderRadius: 9,
  boxShadow: "0 14px 34px var(--terminal-drawer-card-shadow)",
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 152,
  padding: 5,
  position: "absolute",
  right: 0,
  top: "calc(100% + 6px)",
  zIndex: 20,
};

const SESSION_CONTEXT_MENU_ITEM_STYLE: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: 0,
  borderRadius: 7,
  color: "var(--terminal-drawer-fg)",
  cursor: "pointer",
  display: "flex",
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 12,
  fontWeight: 650,
  gap: 7,
  height: 28,
  padding: "0 8px",
  textAlign: "left",
  whiteSpace: "nowrap",
  width: "100%",
};

const SESSION_COPY_FEEDBACK_STYLE: CSSProperties = {
  alignItems: "center",
  background: "var(--terminal-drawer-action-bg)",
  border: "1px solid var(--terminal-drawer-action-border)",
  borderRadius: 999,
  color: "var(--terminal-drawer-action-fg)",
  display: "inline-flex",
  flexShrink: 0,
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 12,
  fontWeight: 750,
  gap: 5,
  height: 24,
  lineHeight: "14px",
  padding: "0 8px",
  pointerEvents: "none",
  whiteSpace: "nowrap",
};

const SESSION_NAME_BUTTON_BASE_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  cursor: "pointer",
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: 14,
  fontWeight: 700,
  lineHeight: "18px",
  minWidth: 0,
  padding: 0,
  pointerEvents: "auto",
  textAlign: "left",
};

const SESSION_RENAME_INPUT_STYLE: CSSProperties = {
  background: "var(--terminal-drawer-card-bg)",
  border: "1px solid var(--terminal-drawer-card-border)",
  borderRadius: 6,
  color: "var(--terminal-drawer-fg)",
  flex: "1 1 auto",
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: 14,
  fontWeight: 700,
  height: 24,
  lineHeight: "18px",
  minWidth: 0,
  outline: "none",
  padding: "0 6px",
  pointerEvents: "auto",
};

export interface ProjectInfo {
  name: string;
  path: string;
  isGit: boolean;
  branch: string | null;
  dirtyCount: number;
  modified: string | null;
}

export interface WorkspaceSessionSummary {
  id: string;
  kind?: "shell" | "agent";
  projectSlug?: string;
  taskId?: string;
  worktreeId?: string;
  pr?: number;
  agent?: "claude" | "codex" | "opencode" | "pi";
  runtime?: {
    status?: string;
  };
  status?: string;
  nativeAttachCommand?: string[];
  transcriptPath?: string;
}

export interface TreeNode {
  name: string;
  type: "file" | "directory";
  size?: number;
  gitStatus: string | null;
  changedCount?: number;
  path: string;
  children?: TreeNode[];
  expanded?: boolean;
}

export function getShellTabCount(shell: ShellSessionSummary): number | null {
  if (!Array.isArray(shell.tabs)) return null;
  return shell.tabs.reduce((count, tab) => {
    const indexedCount = Number.isInteger(tab.idx) && tab.idx >= 0 ? tab.idx + 1 : 0;
    return Math.max(count, indexedCount);
  }, shell.tabs.length);
}

export function formatShellTabCount(shell: ShellSessionSummary): string {
  const count = getShellTabCount(shell);
  if (count === null) return "tabs unknown";
  return `${count} tab${count === 1 ? "" : "s"}`;
}

export function formatShellDisplayName(name: string): string {
  return name === DEFAULT_SHELL_SESSION_NAME ? "matrix-main" : name;
}

function formatCollapsedShellLabel(name: string): string {
  const normalized = formatShellDisplayName(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const parts = normalized.split("-").filter(Boolean);
  const compact = parts.join("");
  let label = "";
  if (parts.length >= 2) {
    label = `${parts[0]?.charAt(0) ?? ""}${parts[1]?.slice(0, 2) ?? ""}`;
  } else {
    label = compact.slice(0, 3);
  }
  if (label.length >= 3) {
    return label.slice(0, 3);
  }
  const fallback = (compact || "shl").slice(label.length);
  const padded = `${label}${fallback}`;
  return padded.padEnd(3, padded.at(-1) ?? "l").slice(0, 3);
}

function shellConnectCommand(name: string): string {
  return `matrix shell connect ${name}`;
}

function shellAttachCommand(shell: ShellSessionSummary): string {
  return shellConnectCommand(shell.name);
}

async function copyTextToClipboard(text: string): Promise<void> {
  let legacyCopyError: unknown = null;
  if (typeof document !== "undefined" && typeof document.execCommand === "function") {
    const previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousSelection = document.getSelection()?.rangeCount ? document.getSelection()?.getRangeAt(0).cloneRange() : null;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    try {
      if (document.execCommand("copy")) {
        return;
      }
      legacyCopyError = new Error("execCommand copy returned false");
    } catch (err: unknown) {
      legacyCopyError = err;
    } finally {
      textarea.remove();
      const selection = document.getSelection();
      if (selection) {
        selection.removeAllRanges();
        if (previousSelection) {
          selection.addRange(previousSelection);
        }
      }
      previousActiveElement?.focus({ preventScroll: true });
    }
  }
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error(legacyCopyError instanceof Error ? legacyCopyError.message : "Clipboard copy unavailable");
}

function getShellVisualStatus(shell: ShellSessionSummary): NonNullable<ShellSessionSummary["visualStatus"]> {
  if (shell.visualStatus) return shell.visualStatus;
  if (shell.status === "degraded") return "waiting";
  if (shell.status === "exited") return shell.unread ? "finished" : "idle";
  return shell.unread ? "finished" : "idle";
}

export function getShellStatusDotStyle(shell: ShellSessionSummary): CSSProperties {
  const status = getShellVisualStatus(shell);
  if (status === "running") {
    return { background: "#5FB85F", boxShadow: "0 0 0 4px rgba(95,184,95,0.24)" };
  }
  if (status === "waiting") {
    return { background: "#E0A12E", boxShadow: "0 0 0 4px rgba(224,161,46,0.25)" };
  }
  if (status === "finished") {
    return { background: "#2E6B3A", boxShadow: "none" };
  }
  return { background: "#A9AA9A", boxShadow: "none" };
}

export function getShellStatusDotClassName(shell: ShellSessionSummary): string {
  return getShellVisualStatus(shell) === "running"
    ? "terminal-session-status-dot terminal-session-status-dot--running"
    : "terminal-session-status-dot";
}

export function CollapsedSessionsRail({
  shells,
  selectedShellName,
  terminalDividerColor,
  onExpand,
  creatingShell,
  newSessionMenuOpen,
  onNew,
  onNewMenuClose,
  onCreateShell,
  onCreateAgent,
  agentStatuses,
  onOpen,
}: {
  shells: ShellSessionSummary[];
  selectedShellName: string | null;
  terminalDividerColor: string;
  onExpand: () => void;
  creatingShell: boolean;
  newSessionMenuOpen: boolean;
  onNew: () => void;
  onNewMenuClose: () => void;
  onCreateShell: () => void;
  onCreateAgent: (option: TerminalAgentOption, installed: boolean) => void;
  agentStatuses: Record<TerminalAgentId, boolean> | null;
  onOpen: (shell: ShellSessionSummary) => void;
}) {
  const activeShells = shells.filter((shell) => shell.placement !== "background");
  const backgroundShells = shells.filter((shell) => shell.placement === "background");
  return (
    <aside
      data-testid="terminal-collapsed-rail"
      className="shrink-0"
      style={{
        alignItems: "center",
        background: "var(--terminal-drawer-bg)",
        borderRight: `1px solid ${terminalDividerColor}`,
        color: "var(--terminal-drawer-fg)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "16px 0",
        width: 76,
      }}
    >
      <div
        data-testid="terminal-collapsed-brand"
        className="flex items-center justify-center"
        style={{
          background: "var(--terminal-drawer-brand-bg)",
          borderRadius: 11,
          flexShrink: 0,
          height: COLLAPSED_RAIL_ITEM_SIZE,
          width: COLLAPSED_RAIL_ITEM_SIZE,
        }}
        title="matrix os"
      >
        <span
          aria-hidden="true"
          data-testid="terminal-collapsed-brand-mask"
          style={{
            background: "var(--terminal-drawer-brand-fg)",
            WebkitMaskImage: "url('/matrix-logo.svg')",
            maskImage: "url('/matrix-logo.svg')",
            WebkitMaskRepeat: "no-repeat",
            maskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
            maskPosition: "center",
            WebkitMaskSize: "contain",
            maskSize: "contain",
            display: "block",
            height: 22,
            width: 22,
          }}
        />
      </div>
      <CollapsedRailButton label="Expand sessions drawer" onClick={onExpand}>
        <ChevronsRightIcon data-testid="terminal-drawer-expand-icon" size={17} strokeWidth={2} />
      </CollapsedRailButton>
      <div style={{ position: "relative" }}>
        <CollapsedRailButton label="New session" onClick={onNew} strong disabled={creatingShell} expanded={newSessionMenuOpen}>
          <PlusIcon aria-hidden="true" data-testid="terminal-collapsed-new-session-icon" size={18} strokeWidth={2.5} />
        </CollapsedRailButton>
        {newSessionMenuOpen ? (
          <NewSessionMenu
            align="left"
            onClose={onNewMenuClose}
            onCreateShell={onCreateShell}
            onCreateAgent={onCreateAgent}
            agentStatuses={agentStatuses}
          />
        ) : null}
      </div>
      <div style={{ background: "var(--terminal-drawer-border)", height: 1, width: 34 }} />
      <CollapsedRailGroup shells={activeShells} selectedShellName={selectedShellName} onOpen={onOpen} />
      {backgroundShells.length > 0 && (
        <>
          <div
            data-testid="terminal-collapsed-background-divider"
            style={{
              background: "var(--terminal-drawer-border)",
              height: 1,
              marginTop: 2,
              width: 36,
            }}
          />
          <CollapsedRailGroup shells={backgroundShells} selectedShellName={selectedShellName} onOpen={onOpen} muted />
        </>
      )}
    </aside>
  );
}

function CollapsedRailGroup({
  shells,
  selectedShellName,
  onOpen,
  muted = false,
}: {
  shells: ShellSessionSummary[];
  selectedShellName: string | null;
  onOpen: (shell: ShellSessionSummary) => void;
  muted?: boolean;
}) {
  return (
    <div className="flex flex-col items-center" style={{ gap: 9 }}>
      {shells.map((shell) => {
        const displayName = formatShellDisplayName(shell.name);
        const label = formatCollapsedShellLabel(shell.name);
        const selected = shell.name === selectedShellName;
        const accent = sessionAccent(shell.name);
        return (
          <button
            key={shell.name}
            type="button"
            aria-label={`Open ${displayName}`}
            aria-current={selected ? "true" : undefined}
            data-selected={selected ? "true" : "false"}
            title={displayName}
            onClick={() => onOpen(shell)}
            className="relative flex items-center justify-center"
            style={{
              background: accent.bg,
              border: `1px solid ${selected ? "var(--terminal-drawer-selected-border)" : accent.border}`,
              borderRadius: 11,
              boxShadow: selected ? "0 0 0 5px var(--terminal-drawer-selected-ring), 0 8px 18px var(--terminal-drawer-card-shadow)" : "none",
              color: accent.fg,
              cursor: "pointer",
              flexShrink: 0,
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              fontSize: 12,
              fontWeight: 700,
              height: COLLAPSED_RAIL_ITEM_SIZE,
              lineHeight: "14px",
              opacity: muted ? 0.72 : 1,
              overflow: "visible",
              width: COLLAPSED_RAIL_ITEM_SIZE,
            }}
          >
            {label}
            <span
              aria-hidden="true"
              className={getShellStatusDotClassName(shell)}
              data-testid={`terminal-session-status-${shell.name}`}
              style={{
                ...getShellStatusDotStyle(shell),
                borderColor: "var(--terminal-drawer-bg)",
                borderStyle: "solid",
                borderWidth: 2,
                borderRadius: 999,
                boxSizing: "border-box",
                height: 12,
                position: "absolute",
                right: -3,
                top: -3,
                width: 12,
                zIndex: 1,
              }}
            />
          </button>
        );
      })}
    </div>
  );
}

function CollapsedRailButton({
  label,
  onClick,
  children,
  strong = false,
  disabled = false,
  expanded = false,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  strong?: boolean;
  disabled?: boolean;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup={label === "New session" ? "menu" : undefined}
      aria-expanded={label === "New session" ? expanded : undefined}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="flex items-center justify-center"
      style={{
        background: strong ? "var(--terminal-drawer-primary-button-bg)" : "var(--terminal-drawer-button-bg)",
        border: strong ? "1px solid var(--terminal-drawer-primary-button-bg)" : "1px solid var(--terminal-drawer-button-border)",
        borderRadius: strong ? 11 : 10,
        color: strong ? "var(--terminal-drawer-primary-button-fg)" : "var(--terminal-drawer-button-fg)",
        cursor: disabled ? "not-allowed" : "pointer",
        flexShrink: 0,
        fontSize: strong ? 24 : 14,
        fontWeight: 700,
        height: COLLAPSED_RAIL_ITEM_SIZE,
        lineHeight: 1,
        opacity: disabled ? 0.72 : 1,
        width: COLLAPSED_RAIL_ITEM_SIZE,
      }}
    >
      {children}
    </button>
  );
}

export function ShellSessionGroup({
  label,
  shells,
  pending = false,
  expanded = true,
  onToggleExpanded,
  deletingShellNames,
  foreground,
  selectedShellName,
  onOpen,
  onToggle,
  onRename,
  onDelete,
  draggingShellName,
  dragOverShellName,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  label: "Active" | "Background";
  shells: ShellSessionSummary[];
  pending?: boolean;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  deletingShellNames: string[];
  foreground: boolean;
  selectedShellName: string | null;
  onOpen: (shell: ShellSessionSummary) => void;
  onToggle: (shell: ShellSessionSummary) => void;
  onRename: (shell: ShellSessionSummary, nextName: string) => Promise<boolean>;
  onDelete: (shell: ShellSessionSummary, anchorElement: HTMLElement, returnFocusElement: HTMLButtonElement) => void;
  draggingShellName: string | null;
  dragOverShellName: string | null;
  onDragStart: (shell: ShellSessionSummary) => void;
  onDragOver: (shell: ShellSessionSummary) => void;
  onDrop: (shell: ShellSessionSummary) => void;
  onDragEnd: () => void;
}) {
  const collapsible = label === "Background";
  const contentId = `terminal-session-group-${label.toLowerCase()}-content`;
  return (
    <section data-testid={`terminal-session-group-${label.toLowerCase()}`} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="flex items-center justify-between" style={{ color: "var(--terminal-drawer-muted)", minHeight: 22 }}>
        <button
          type="button"
          aria-label={collapsible ? "Toggle Background sessions" : undefined}
          aria-expanded={collapsible ? expanded : undefined}
          aria-controls={collapsible ? contentId : undefined}
          disabled={!collapsible}
          onClick={collapsible ? onToggleExpanded : undefined}
          className="flex items-center"
          style={{
            background: "transparent",
            border: 0,
            color: "var(--terminal-drawer-muted)",
            cursor: collapsible ? "pointer" : "default",
            gap: 7,
            padding: 0,
            textAlign: "left",
          }}
        >
          {collapsible && (
            <ChevronRightIcon
              aria-hidden="true"
              data-testid="terminal-session-background-chevron"
              size={12}
              strokeWidth={2.5}
              style={{
                transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 140ms ease",
              }}
            />
          )}
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", lineHeight: "14px", textTransform: "uppercase" }}>
            {label}{" "}
            <span style={{ fontWeight: 600, opacity: 0.55 }}>({shells.length})</span>
          </span>
        </button>
      </div>
      <div
        id={contentId}
        hidden={!expanded}
        style={{ display: expanded ? "flex" : undefined, flexDirection: "column", gap: 10 }}
      >
        {expanded ? (
          <>
            {pending ? <ShellPendingCard /> : null}
            {shells.length === 0 && !pending ? (
              <div style={{ color: "var(--terminal-drawer-subtle)", fontSize: 12, padding: "8px 0 6px" }}>
                {foreground ? "No active sessions" : "Nothing running in background"}
              </div>
            ) : shells.map((shell) => (
              <ShellCard
                key={`${label}-${shell.name}`}
                shell={shell}
                foreground={foreground}
                deleting={deletingShellNames.includes(shell.name)}
                selected={shell.name === selectedShellName}
                onOpen={() => onOpen(shell)}
                onToggle={() => onToggle(shell)}
                onRename={(nextName) => onRename(shell, nextName)}
                onDelete={(anchorElement, returnFocusElement) => onDelete(shell, anchorElement, returnFocusElement)}
                dragging={shell.name === draggingShellName}
                dropTarget={shell.name === dragOverShellName}
                onDragStart={() => onDragStart(shell)}
                onDragOver={() => onDragOver(shell)}
                onDrop={() => onDrop(shell)}
                onDragEnd={onDragEnd}
              />
            ))}
          </>
        ) : null}
      </div>
    </section>
  );
}

function ShellPendingCard() {
  return (
    <output
      aria-label="Creating shell session"
      data-testid="terminal-session-pending-row"
      style={{
        alignItems: "center",
        background: "var(--terminal-drawer-card-bg)",
        border: "1px solid var(--terminal-drawer-card-border)",
        borderRadius: 8,
        boxShadow: "0 9px 22px var(--terminal-drawer-card-shadow)",
        color: "var(--terminal-drawer-muted)",
        display: "grid",
        gap: 10,
        gridTemplateColumns: "12px 8px minmax(0, 1fr) 58px 46px",
        height: 52,
        opacity: 0.82,
        padding: "0 12px",
      }}
    >
      <span style={{ width: 12 }} />
      <span
        aria-hidden="true"
        className="terminal-refresh-icon--loading"
        style={{
          border: "2px solid var(--terminal-drawer-card-border)",
          borderTopColor: "var(--terminal-drawer-selected-stripe)",
          borderRadius: "50%",
          height: 8,
          width: 8,
        }}
      />
      <span
        style={{
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
          fontSize: 14,
          fontWeight: 700,
          lineHeight: "18px",
          minWidth: 0,
        }}
      >
        Creating session
      </span>
      <span />
      <span
        style={{
          background: "var(--terminal-drawer-action-bg)",
          border: "1px solid var(--terminal-drawer-action-border)",
          borderRadius: 999,
          color: "var(--terminal-drawer-action-fg)",
          fontSize: 12,
          fontWeight: 800,
          lineHeight: "18px",
          textAlign: "center",
        }}
      >
        NEW
      </span>
    </output>
  );
}

function ShellCard({
  shell,
  foreground,
  deleting,
  selected,
  onOpen,
  onToggle,
  onRename,
  onDelete,
  dragging,
  dropTarget,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  shell: ShellSessionSummary;
  foreground: boolean;
  deleting?: boolean;
  selected: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onRename: (nextName: string) => Promise<boolean>;
  onDelete: (anchorElement: HTMLElement, returnFocusElement: HTMLButtonElement) => void;
  dragging: boolean;
  dropTarget: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const statusDotStyle = getShellStatusDotStyle(shell);
  const [copyFeedback, setCopyFeedback] = useState<"copied" | "failed" | null>(null);
  const displayName = formatShellDisplayName(shell.name);
  const [actionsVisible, setActionsVisible] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [hoverCardOpen, setHoverCardOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(shell.name);
  const [renameSaving, setRenameSaving] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameCommittingRef = useRef(false);
  const copiedTimerRef = useRef<number | null>(null);
  const restoreFocusAfterMenuCloseRef = useRef(false);
  const showActions = actionsVisible || copyFeedback !== null || contextMenuOpen;
  const showRenameControl = actionsVisible && !renaming;
  const showDragHandle = (actionsVisible || dragging) && !renaming && !deleting;
  const renameControlLabel = `Rename ${displayName}`;
  const toggleMenuLabel = foreground ? "Move to Background" : "Make Active";
  const agentName = shell.agent ? formatTerminalAgentName(shell.agent) : null;
  const liveState = getShellVisualStatus(shell);
  const hoverSuppressed = contextMenuOpen || renaming || dragging || Boolean(deleting);
  const getContextMenuItems = () => Array.from(
    contextMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
  );
  const focusContextMenuItem = (nextIndex: number) => {
    const items = getContextMenuItems();
    if (items.length === 0) return;
    const normalizedIndex = (nextIndex + items.length) % items.length;
    items[normalizedIndex]?.focus();
  };
  const handleContextMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      restoreFocusAfterMenuCloseRef.current = true;
      setContextMenuOpen(false);
      return;
    }
    const items = getContextMenuItems();
    if (items.length === 0) return;
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusContextMenuItem(currentIndex < 0 ? 0 : currentIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusContextMenuItem(currentIndex < 0 ? items.length - 1 : currentIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusContextMenuItem(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusContextMenuItem(items.length - 1);
    }
  };

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!renaming) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renaming]);

  useEffect(() => {
    if (!contextMenuOpen) return;
    const firstMenuItem = contextMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    firstMenuItem?.focus();
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && cardRef.current?.contains(target)) return;
      restoreFocusAfterMenuCloseRef.current = false;
      setContextMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [contextMenuOpen]);

  useEffect(() => {
    if (contextMenuOpen || !restoreFocusAfterMenuCloseRef.current) return;
    restoreFocusAfterMenuCloseRef.current = false;
    moreButtonRef.current?.focus();
  }, [contextMenuOpen]);

  const closeContextMenuWithFocusReturn = () => {
    restoreFocusAfterMenuCloseRef.current = true;
    setContextMenuOpen(false);
  };

  const copyAttachCommand = async () => {
    try {
      await copyTextToClipboard(shellAttachCommand(shell));
      setCopyFeedback("copied");
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null;
        setCopyFeedback(null);
      }, 1200);
    } catch (err: unknown) {
      console.warn("Failed to copy shell connect command:", err instanceof Error ? err.message : err);
      setCopyFeedback("failed");
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null;
        setCopyFeedback(null);
      }, 1600);
    }
  };
  const cancelRename = useCallback(() => {
    setRenameDraft(shell.name);
    setRenaming(false);
  }, [shell.name]);

  const commitRename = useCallback(async (draft = renameDraft) => {
    const nextName = draft.trim();
    if (!nextName) {
      cancelRename();
      return;
    }
    if (renameSaving || renameCommittingRef.current) return;
    if (nextName === shell.name) {
      setRenaming(false);
      return;
    }
    renameCommittingRef.current = true;
    setRenameSaving(true);
    let renamed = false;
    try {
      renamed = await onRename(nextName);
    } catch (err: unknown) {
      console.warn("Failed to commit shell session rename:", err instanceof Error ? err.message : err);
    }
    if (renamed) {
      setRenaming(false);
    }
    renameCommittingRef.current = false;
    setRenameSaving(false);
  }, [cancelRename, onRename, renameDraft, renameSaving, shell.name]);

  const finishRename = useCallback(() => {
    if (renameCommittingRef.current) return;
    const nextDraft = renameInputRef.current?.value ?? renameDraft;
    if (nextDraft.trim() === shell.name || nextDraft.trim().length === 0) {
      cancelRename();
      return;
    }
    void commitRename(nextDraft);
  }, [cancelRename, commitRename, renameDraft, shell.name]);

  useEffect(() => {
    if (!renaming) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && cardRef.current?.contains(target)) {
        return;
      }
      finishRename();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [finishRename, renaming]);

  const handleCardClick = () => {
    if (renaming || renameSaving || deleting) return;
    onOpen();
  };

  const card = (
    <div
      ref={cardRef}
      className="group terminal-session-card"
      data-testid={`terminal-session-card-${shell.name}`}
      onDragOver={(event) => {
        if (!dragging) {
          event.preventDefault();
        }
        event.dataTransfer.dropEffect = "move";
        onDragOver();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onMouseEnter={() => setActionsVisible(true)}
      onMouseMove={() => setActionsVisible(true)}
      onMouseOver={() => setActionsVisible(true)}
      onMouseLeave={() => setActionsVisible(false)}
      onPointerEnter={() => setActionsVisible(true)}
      onPointerMove={() => setActionsVisible(true)}
      onPointerOver={() => setActionsVisible(true)}
      onPointerLeave={() => setActionsVisible(false)}
      onFocus={() => setActionsVisible(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setActionsVisible(false);
        }
      }}
      style={{
        background: selected ? "var(--terminal-drawer-card-bg)" : foreground ? "var(--terminal-drawer-card-bg)" : "var(--terminal-drawer-card-muted-bg)",
        border: `1px solid ${selected ? "var(--terminal-drawer-selected-border)" : foreground ? "var(--terminal-drawer-card-border)" : "var(--terminal-drawer-card-muted-border)"}`,
        borderRadius: 10,
        boxShadow: dragging
          ? "0 18px 34px var(--terminal-drawer-card-shadow)"
          : selected
            ? "0 0 0 5px var(--terminal-drawer-selected-ring), 0 14px 30px var(--terminal-drawer-card-shadow)"
            : foreground ? "0 9px 22px var(--terminal-drawer-card-shadow)" : "none",
        cursor: renaming || deleting ? "default" : "pointer",
        alignItems: "center",
        display: "grid",
        gap: 10,
        gridTemplateColumns: "minmax(0, 1fr)",
        height: shell.agent ? 78 : 52,
        opacity: dragging ? 0.94 : foreground ? 1 : 0.86,
        padding: "0 12px",
        position: "relative",
        transform: dragging ? "translateY(-2px)" : undefined,
        transition: "border-color 150ms ease, box-shadow 150ms ease, opacity 120ms ease, transform 150ms ease",
        zIndex: contextMenuOpen ? SHELL_Z_INDEX.terminalSessionMenuCard : dragging ? 1 : undefined,
      }}
    >
      {dropTarget && (
        <span
          aria-hidden="true"
          data-testid={`terminal-session-drop-line-${shell.name}`}
          style={{
            background: "var(--terminal-drawer-drop-line)",
            borderRadius: 999,
            height: 3,
            left: 12,
            position: "absolute",
            right: 12,
            top: -7,
            zIndex: 3,
          }}
        />
      )}
      {selected && (
        <span
          aria-hidden="true"
          style={{
            background: "var(--terminal-drawer-selected-stripe)",
            borderRadius: 999,
            bottom: 12,
            left: -1,
            position: "absolute",
            top: 12,
            width: 3,
            zIndex: 2,
          }}
        />
      )}
      {!renaming && !deleting && (
        <button
          type="button"
          data-testid={`terminal-session-row-${shell.name}`}
          aria-current={selected ? "true" : undefined}
          aria-label={`Show ${displayName} session`}
          data-selected={selected ? "true" : "false"}
          onClick={handleCardClick}
          style={SHELL_ROW_BUTTON_STYLE}
        />
      )}
      <div
        className="min-w-0"
        style={{
          alignItems: "center",
          display: "grid",
          gap: 10,
          gridTemplateColumns: "12px 8px minmax(0, 1fr)",
          pointerEvents: "none",
          position: "relative",
          zIndex: 1,
        }}
      >
        <button
          type="button"
          aria-label={`Drag ${displayName} session`}
          draggable={!renaming && !deleting}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", shell.name);
            onDragStart();
          }}
          onDragEnd={(event) => {
            event.stopPropagation();
            onDragEnd();
          }}
          className="flex items-center justify-center"
          style={{
            ...SHELL_ROW_DRAG_HANDLE_STYLE,
            cursor: showDragHandle ? "grab" : "default",
            opacity: showDragHandle ? 1 : 0,
          }}
        >
          <GripVerticalIcon size={12} strokeWidth={2.1} />
        </button>
        <span
          className={getShellStatusDotClassName(shell)}
          data-testid={`terminal-session-status-${shell.name}`}
          style={{
            width: foreground ? 7 : 8,
            height: foreground ? 7 : 8,
            borderRadius: "50%",
            flexShrink: 0,
            ...statusDotStyle,
          }}
        />
        <div
          className="min-w-0"
          style={{
            alignContent: "center",
            display: "grid",
            gap: shell.agent ? 2 : 0,
            gridTemplateColumns: "minmax(0, 1fr)",
            gridTemplateRows: shell.agent ? "18px 16px 16px" : "24px",
            paddingRight: 34,
          }}
        >
          <div
            data-testid={`terminal-session-name-row-${shell.name}`}
            style={{ alignItems: "center", display: "flex", gap: 5, minWidth: 0 }}
          >
            {renaming ? (
              <input
                ref={renameInputRef}
                aria-label={`Session name for ${displayName}`}
                value={renameDraft}
                disabled={renameSaving}
                onChange={(event) => setRenameDraft(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onBlur={finishRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void commitRename();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelRename();
                  }
                }}
                style={SESSION_RENAME_INPUT_STYLE}
              />
            ) : (
              <>
                <button
                  type="button"
                  data-session-name={shell.name}
                  data-testid={`terminal-session-name-${shell.name}`}
                  aria-label={`Open ${displayName}`}
                  className="min-w-0 truncate"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpen();
                  }}
                  style={{
                    ...SESSION_NAME_BUTTON_BASE_STYLE,
                    color: foreground ? "var(--terminal-drawer-fg)" : "var(--terminal-drawer-muted)",
                    flex: "0 1 auto",
                    maxWidth: "calc(100% - 27px)",
                  }}
                >
                  {displayName}
                </button>
                <button
                  type="button"
                  aria-label={renameControlLabel}
                  title={renameControlLabel}
                  disabled={renameSaving}
                  tabIndex={showActions ? 0 : -1}
                  onClick={(event) => {
                    event.stopPropagation();
                    setHoverCardOpen(false);
                    setRenameDraft(shell.name);
                    setRenaming(true);
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  className="flex items-center justify-center"
                  style={{
                    ...SESSION_RENAME_BUTTON_STYLE,
                    cursor: renameSaving ? "not-allowed" : "pointer",
                    opacity: showRenameControl ? 1 : 0,
                  }}
                >
                  <PencilIcon size={12} strokeWidth={2} />
                </button>
              </>
            )}
          </div>
          {shell.agent ? (
            <span
              data-testid={`terminal-session-subtitle-${shell.name}`}
              style={{
                color: "var(--terminal-drawer-muted)",
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: 11,
                lineHeight: "16px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={shell.subtitle}
            >
              {shell.subtitle ?? ""}
            </span>
          ) : null}
          {shell.agent && agentName ? (
            <span
              data-testid={`terminal-session-agent-state-${shell.name}`}
              style={{
                color: "var(--terminal-drawer-subtle)",
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: 10,
                fontWeight: 700,
                lineHeight: "16px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                textTransform: "capitalize",
                whiteSpace: "nowrap",
              }}
            >
              {agentName} <span aria-hidden="true">·</span> {liveState}
            </span>
          ) : null}
          {!renaming && (
            <div
              data-testid={`terminal-session-actions-${shell.name}`}
              aria-hidden={showActions ? undefined : "true"}
              className="flex shrink-0 items-center justify-end"
              style={{
                ...SESSION_ACTIONS_STYLE,
                opacity: showActions ? 1 : 0,
                pointerEvents: showActions ? "auto" : "none",
              }}
            >
              <div style={{ position: "relative" }}>
                <button
                  ref={moreButtonRef}
                  type="button"
                  aria-label={`More actions for ${displayName}`}
                  aria-haspopup="menu"
                  aria-expanded={contextMenuOpen}
                  tabIndex={showActions ? 0 : -1}
                  onClick={(event) => {
                    event.stopPropagation();
                    setHoverCardOpen(false);
                    restoreFocusAfterMenuCloseRef.current = true;
                    setContextMenuOpen((open) => !open);
                  }}
                  onFocus={() => setHoverCardOpen(false)}
                  onPointerEnter={() => setHoverCardOpen(false)}
                  onPointerDown={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  className="flex items-center justify-center"
                  style={{
                    ...SESSION_MORE_BUTTON_STYLE,
                    opacity: showActions ? 1 : 0,
                  }}
                >
                  <MoreHorizontalIcon size={14} strokeWidth={2.2} />
                </button>
                {contextMenuOpen ? (
                  <div
                    ref={contextMenuRef}
                    role="menu"
                    aria-label={`Actions for ${displayName}`}
                    tabIndex={-1}
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onKeyDown={handleContextMenuKeyDown}
                    style={SESSION_CONTEXT_MENU_STYLE}
                  >
                    <SessionContextMenuItem
                      label={toggleMenuLabel}
                      onClick={() => {
                        closeContextMenuWithFocusReturn();
                        onToggle();
                      }}
                    >
                      <Rows2Icon size={13} strokeWidth={2} />
                    </SessionContextMenuItem>
                    <SessionContextMenuItem
                      label="Copy Connect Command"
                      onClick={() => {
                        void copyAttachCommand();
                        closeContextMenuWithFocusReturn();
                      }}
                    >
                      <LinkIcon size={13} strokeWidth={2} />
                    </SessionContextMenuItem>
                    <SessionContextMenuItem
                      label={deleting ? "Deleting" : "Close"}
                      disabled={deleting}
                      onClick={() => {
                        if (deleting) return;
                        const anchorElement = cardRef.current;
                        const returnFocusElement = moreButtonRef.current;
                        closeContextMenuWithFocusReturn();
                        if (anchorElement && returnFocusElement) {
                          onDelete(anchorElement, returnFocusElement);
                        }
                      }}
                    >
                      <Trash2Icon size={13} strokeWidth={2} />
                    </SessionContextMenuItem>
                  </div>
                ) : null}
              </div>
              {copyFeedback ? (
                <output
                  data-testid={`terminal-session-copy-toast-${shell.name}`}
                  aria-live="polite"
                  style={{
                    ...SESSION_COPY_FEEDBACK_STYLE,
                    color: copyFeedback === "copied"
                      ? "var(--terminal-drawer-selected-stripe)"
                      : "var(--terminal-drawer-warning-fg)",
                  }}
                >
                  {copyFeedback === "copied" ? (
                    <CheckIcon aria-hidden="true" size={12} strokeWidth={2.4} />
                  ) : (
                    <span aria-hidden="true" style={{ fontSize: 12, fontWeight: 900 }}>!</span>
                  )}
                  <span>{copyFeedback === "copied" ? "Copied" : "Copy failed"}</span>
                </output>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (!shell.agent || !agentName) return card;
  return (
    <TerminalSessionHoverCard
      shell={shell as ShellSessionSummary & { agent: NonNullable<ShellSessionSummary["agent"]> }}
      displayName={displayName}
      cardRef={cardRef}
      open={hoverCardOpen}
      suppressed={hoverSuppressed}
      onOpenChange={setHoverCardOpen}
    >
      {card}
    </TerminalSessionHoverCard>
  );
}

function SessionContextMenuItem({
  label,
  children,
  disabled = false,
  onClick,
}: {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      style={{
        ...SESSION_CONTEXT_MENU_ITEM_STYLE,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.62 : 1,
      }}
      onMouseEnter={(event) => {
        if (!disabled) event.currentTarget.style.background = "var(--terminal-drawer-action-bg)";
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = "transparent";
      }}
    >
      <span aria-hidden="true" style={{ color: "var(--terminal-drawer-action-fg)", display: "flex", flexShrink: 0 }}>
        {children}
      </span>
      <span>{label}</span>
    </button>
  );
}

export function filterTreeNodes(nodes: TreeNode[], normalizedFilter: string): TreeNode[] {
  return nodes.flatMap((node) => {
    const children = node.children ? filterTreeNodes(node.children, normalizedFilter) : [];
    const matches = [
      node.name,
      node.path,
      node.gitStatus,
    ].filter(Boolean).join(" ").toLowerCase().includes(normalizedFilter);

    if (matches) {
      return [{ ...node, expanded: node.type === "directory" ? true : node.expanded }];
    }
    if (children.length > 0) {
      return [{ ...node, children, expanded: true }];
    }
    return [];
  });
}

export function updateNode(nodes: TreeNode[], path: string, update: Partial<TreeNode>): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === path) return { ...node, ...update };
    if (node.children) return { ...node, children: updateNode(node.children, path, update) };
    return node;
  });
}
