import { useRef, type CSSProperties, type KeyboardEvent, type MouseEventHandler, type PointerEventHandler, type ReactNode } from "react";
import { PanelLeftOpenIcon } from "lucide-react";

import { DEFAULT_SHELL_SESSION_NAME } from "./TerminalSidebarItems";
import { useTerminalAppContext } from "./TerminalAppContext";
import { ThemePickerButton } from "./TerminalThemePicker";

const TOOLBAR_BTN_BASE_STYLE: CSSProperties = {
  height: 28,
  minWidth: 28,
  fontSize: 12,
  borderRadius: 6,
};

const TAB_ITEM_BASE_STYLE: CSSProperties = {
  borderRadius: 6,
  fontSize: 12,
  height: 34,
};

const TAB_CLOSE_BUTTON_STYLE: CSSProperties = {
  width: 16,
  height: 16,
  flexShrink: 0,
  borderRadius: 3,
  border: "none",
  background: "transparent",
  color: "var(--muted-foreground)",
  opacity: 0.5,
  marginLeft: "auto",
};

const ACTIVE_TAB_PILL_STYLE: CSSProperties = {
  alignItems: "center",
  alignSelf: "center",
  background: "color-mix(in srgb, var(--primary) 16%, transparent)",
  border: "1px solid color-mix(in srgb, var(--primary) 44%, transparent)",
  borderRadius: 999,
  color: "var(--primary)",
  display: "inline-flex",
  flex: "0 0 auto",
  fontSize: 10,
  fontWeight: 800,
  height: 16,
  lineHeight: "14px",
  overflow: "hidden",
  padding: "0 5px",
};

const ICON_SIZE = 16;

function IconPlus() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <line x1="8" y1="3" x2="8" y2="13" />
      <line x1="3" y1="8" x2="13" y2="8" />
    </svg>
  );
}
function IconClose() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <line x1="3" y1="3" x2="9" y2="9" />
      <line x1="9" y1="3" x2="3" y2="9" />
    </svg>
  );
}
interface ToolbarBtnProps {
  onClick: () => void;
  title: string;
  children: ReactNode;
  variant?: "default" | "primary" | "success";
  ariaLabel?: string;
}
function ToolbarBtn({ onClick, title, children, variant = "default", ariaLabel }: ToolbarBtnProps) {
  const colors =
    variant === "success"
      ? { bg: "var(--success)", color: "white", border: "transparent" }
      : variant === "primary"
        ? { bg: "var(--primary)", color: "white", border: "transparent" }
        : { bg: "transparent", color: "var(--muted-foreground)", border: "transparent" };
  return (
    <button
      type="button"
      className="cursor-pointer transition-colors flex items-center justify-center gap-1.5"
      style={{
        ...TOOLBAR_BTN_BASE_STYLE,
        padding: variant === "default" ? "0 6px" : "0 10px",
        fontWeight: variant === "default" ? 400 : 500,
        background: colors.bg,
        color: colors.color,
        border: `1px solid ${colors.border}`,
      }}
      onMouseEnter={(e) => {
        if (variant === "default") {
          e.currentTarget.style.background = "var(--accent)";
          e.currentTarget.style.color = "var(--foreground)";
        } else {
          e.currentTarget.style.opacity = "0.85";
        }
      }}
      onMouseLeave={(e) => {
        if (variant === "default") {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--muted-foreground)";
        } else {
          e.currentTarget.style.opacity = "1";
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}

function isTerminalChromeControl(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button,input,textarea,select,a,[role='button']"));
}

export function TerminalWorkspaceChrome() {
  const ctx = useTerminalAppContext();
  const activeTab = ctx.tabs.find((tab) => tab.id === ctx.activeTabId);
  const activeName = activeTab?.label === DEFAULT_SHELL_SESSION_NAME ? "matrix-main" : activeTab?.label ?? "Terminal";
  const dragHandleProps = ctx.windowControls?.dragHandleProps;
  const handleDragPointerDownCapture: PointerEventHandler<HTMLElement> = (event) => {
    if (ctx.mobile || isTerminalChromeControl(event.target)) return;
    dragHandleProps?.onPointerDown?.(event);
  };
  const handleDragMouseDownCapture: MouseEventHandler<HTMLElement> = (event) => {
    if (ctx.mobile || isTerminalChromeControl(event.target)) return;
    dragHandleProps?.onMouseDown?.(event);
  };
  const handleDragDoubleClick: MouseEventHandler<HTMLElement> = (event) => {
    if (ctx.mobile || isTerminalChromeControl(event.target)) return;
    dragHandleProps?.onDoubleClick?.(event);
  };

  return (
    <div
      className="shrink-0 select-none"
      onPointerDownCapture={handleDragPointerDownCapture}
      onPointerMove={dragHandleProps?.onPointerMove}
      onPointerUp={dragHandleProps?.onPointerUp}
      onPointerCancel={dragHandleProps?.onPointerCancel}
      onMouseDownCapture={handleDragMouseDownCapture}
      onDoubleClick={handleDragDoubleClick}
      style={{
        alignItems: "center",
        background: "var(--terminal-chrome-bg)",
        borderBottom: "1px solid var(--terminal-chrome-border)",
        color: "var(--terminal-chrome-fg)",
        display: "flex",
        height: ctx.mobile ? 52 : 54,
        justifyContent: "space-between",
        padding: ctx.mobile ? "0 12px" : "0 20px",
        minWidth: 0,
        cursor: dragHandleProps && !ctx.mobile ? "grab" : undefined,
        touchAction: dragHandleProps && !ctx.mobile ? "none" : undefined,
      }}
    >
      <div className="flex min-w-0 items-center" style={{ gap: ctx.mobile ? 10 : 16 }}>
        {!ctx.mobile && (
          <>
            <div className="flex shrink-0 items-center" style={{ gap: 9 }}>
              <TerminalTrafficButton
                label="Close Terminal window"
                color="#E8796B"
                onClick={ctx.windowControls?.close}
              />
              <TerminalTrafficButton
                label="Minimize Terminal window"
                color="#E5BE5F"
                onClick={ctx.windowControls?.minimize}
              />
              <TerminalTrafficButton
                label="Toggle Terminal fullscreen"
                color="#77B861"
                onClick={ctx.windowControls?.toggleFullscreen}
              />
            </div>
            <span style={{ background: "var(--terminal-chrome-control-border)", height: 22, width: 1 }} />
          </>
        )}
        {ctx.mobile ? (
          <button
            type="button"
            aria-label={ctx.sidebarOpen ? "Hide sessions" : "Back to sessions"}
            onClick={() => ctx.setSidebarOpen((open) => !open)}
            style={{
              alignItems: "center",
              background: "transparent",
              border: 0,
              color: "var(--terminal-chrome-fg)",
              cursor: "pointer",
              display: "flex",
              height: 40,
              justifyContent: "center",
              width: 40,
            }}
          >
            <PanelLeftOpenIcon size={18} strokeWidth={1.9} />
          </button>
        ) : null}
        <div className="flex min-w-0 items-center" style={{ gap: 10, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
          <span style={{ color: "var(--terminal-chrome-muted)", fontSize: 15, lineHeight: "20px" }}>matrix-os</span>
          {!ctx.mobile && <span style={{ color: "var(--terminal-chrome-subtle)", fontSize: 15 }}>/</span>}
          <span className="truncate" style={{ color: "var(--terminal-chrome-active)", fontSize: 15, fontWeight: 700, lineHeight: "20px" }}>
            {activeName}
          </span>
          {!ctx.mobile && (
            <span
              className="inline-flex shrink-0 items-center"
              style={{
                background: "var(--terminal-chrome-badge-bg)",
                border: "1px solid var(--terminal-chrome-badge-border)",
                borderRadius: 8,
                boxSizing: "border-box",
                color: "var(--terminal-chrome-muted)",
                fontSize: 11,
                gap: 5,
                height: 22,
                lineHeight: "14px",
                overflow: "hidden",
                padding: "0 8px",
              }}
            >
              main
            </span>
          )}
        </div>
      </div>
      <span aria-hidden="true" style={{ width: ctx.mobile ? 40 : 0 }} />
    </div>
  );
}

/**
 * Slim terminal toolbar used when the host window already renders a generic
 * window header (Developer mode). It drops the redundant traffic lights and
 * breadcrumb and keeps only the terminal-specific controls — split and theme —
 * so the window reads like every other app window while staying fully featured.
 */
export function TerminalEmbeddedToolbar() {
  const ctx = useTerminalAppContext();
  return (
    <div
      className="shrink-0 select-none flex items-center justify-between"
      style={{
        background: "var(--terminal-chrome-bg)",
        borderBottom: "1px solid var(--terminal-chrome-border)",
        color: "var(--terminal-chrome-fg)",
        height: ctx.mobile ? 44 : 40,
        padding: "0 10px",
        minWidth: 0,
      }}
    >
      {ctx.mobile ? (
        <button
          type="button"
          aria-label={ctx.sidebarOpen ? "Hide sessions" : "Back to sessions"}
          onClick={() => ctx.setSidebarOpen((open) => !open)}
          style={{
            alignItems: "center",
            background: "transparent",
            border: 0,
            color: "var(--terminal-chrome-fg)",
            cursor: "pointer",
            display: "flex",
            height: 36,
            justifyContent: "center",
            width: 36,
          }}
        >
          <PanelLeftOpenIcon size={18} strokeWidth={1.9} />
        </button>
      ) : <span />}
      <span aria-hidden="true" style={{ width: ctx.mobile ? 36 : 0 }} />
    </div>
  );
}

function TerminalTrafficButton({
  label,
  color,
  onClick,
}: {
  label: string;
  color: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      style={{
        background: color,
        border: 0,
        borderRadius: 999,
        cursor: "pointer",
        height: 13,
        padding: 0,
        width: 13,
      }}
    />
  );
}

export function LocalTerminalTabBar({ defaultCwd }: { defaultCwd: string }) {
  const ctx = useTerminalAppContext();
  const dragIndexRef = useRef<number | null>(null);

  const getCwd = () => ctx.sidebarSelectedPath ?? defaultCwd;
  const newTabButton = (
    <ToolbarBtn
      onClick={() => { void ctx.createShellSessionTab("Shell", getCwd()); }}
      title="New tab (Ctrl+Shift+T)"
      ariaLabel="New tab"
    >
      <IconPlus />
    </ToolbarBtn>
  );

  return (
    <div
      className="grid items-stretch border-b shrink-0 select-none"
      style={{
        background: "var(--card)",
        borderColor: "var(--border)",
        height: ctx.mobile ? 50 : 44,
        padding: "4px 6px",
        gap: 4,
        gridTemplateColumns: ctx.mobile ? "1fr" : "minmax(0, 1fr) auto",
        minWidth: 0,
      }}
    >
      <div
        className="flex items-stretch overflow-x-auto min-w-0"
        role="tablist"
        aria-label="Terminal tabs"
        style={{
          gap: 3,
          scrollbarWidth: "thin",
          overscrollBehaviorX: "contain",
        }}
      >
        {ctx.tabs.map((tab, i) => {
          const active = tab.id === ctx.activeTabId;
          const handleTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
            if (e.target !== e.currentTarget) return;

            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              ctx.setActiveTab(tab.id);
              return;
            }

            const keyToIndex: Record<string, number> = {
              ArrowLeft: i === 0 ? ctx.tabs.length - 1 : i - 1,
              ArrowRight: i === ctx.tabs.length - 1 ? 0 : i + 1,
              Home: 0,
              End: ctx.tabs.length - 1,
            };
            const nextIndex = keyToIndex[e.key];
            const nextTab = ctx.tabs[nextIndex];
            if (!nextTab) return;

            e.preventDefault();
            ctx.setActiveTab(nextTab.id);
            const tabs = Array.from(
              e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
            );
            tabs[nextIndex]?.focus();
          };
          const tabNode = (
            <div
              key={tab.id}
              role="tab"
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              className="flex items-center gap-1.5 cursor-pointer whitespace-nowrap transition-colors"
              style={{
                ...TAB_ITEM_BASE_STYLE,
                background: active ? "var(--background)" : "color-mix(in srgb, var(--background) 42%, transparent)",
                color: active ? "var(--foreground)" : "var(--muted-foreground)",
                border: `1px solid ${active ? "var(--primary)" : "color-mix(in srgb, var(--border) 55%, transparent)"}`,
                padding: ctx.mobile ? "0 7px" : "0 8px",
                fontWeight: active ? 750 : 450,
                flex: ctx.mobile ? "0 1 148px" : "0 1 168px",
                minWidth: ctx.mobile ? 96 : 108,
                maxWidth: ctx.mobile ? 160 : 190,
                boxShadow: active ? "inset 0 -3px 0 var(--primary), 0 0 0 1px color-mix(in srgb, var(--primary) 28%, transparent)" : "none",
              }}
              draggable
              onClick={() => ctx.setActiveTab(tab.id)}
              onKeyDown={handleTabKeyDown}
              onDragStart={() => { dragIndexRef.current = i; }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); if (dragIndexRef.current !== null && dragIndexRef.current !== i) ctx.reorderTabs(dragIndexRef.current, i); dragIndexRef.current = null; }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  flexShrink: 0,
                  borderRadius: "50%",
                  background: active ? "var(--success)" : "var(--muted-foreground)",
                  opacity: active ? 1 : 0.5,
                }}
              />
              <span
                className="min-w-0 truncate"
                style={{ flex: "1 1 auto", overflow: "hidden" }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{tab.label}</span>
              </span>
              {active && (
                <span
                  aria-hidden="true"
                  style={ACTIVE_TAB_PILL_STYLE}
                >
                  Active
                </span>
              )}
              <button
                type="button"
                className="cursor-pointer flex items-center justify-center transition-colors"
                onClick={(e) => { e.stopPropagation(); ctx.closeTab(tab.id); }}
                style={TAB_CLOSE_BUTTON_STYLE}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.background = "var(--accent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.5"; e.currentTarget.style.background = "transparent"; }}
                aria-label="Close tab"
                title="Close tab"
              >
                <IconClose />
                <span className="sr-only">x</span>
              </button>
            </div>
          );
          return tabNode;
        })}
        {newTabButton}
      </div>
      {!ctx.mobile && (
      <div
        className="flex items-center shrink-0"
        style={{
          gap: 4,
          paddingLeft: 8,
          borderLeft: "1px solid var(--border)",
          minWidth: 0,
        }}
      >
          <>
            <ToolbarBtn
              onClick={() => ctx.addTab(getCwd(), "Claude Code", true)}
              title="Launch Claude Code (Ctrl+Shift+C)"
              variant="success"
            >
              Claude
            </ToolbarBtn>
            <ToolbarBtn
              onClick={() => { void ctx.createShellSessionTab("Shell", getCwd()); }}
              title="Launch Shell (Ctrl+Shift+Z)"
              variant="primary"
            >
              Shell
            </ToolbarBtn>
            <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 4px" }} />
            <ThemePickerButton mobile={ctx.mobile} />
          </>
      </div>
      )}
    </div>
  );
}
