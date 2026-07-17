import type { MouseEventHandler, PointerEventHandler } from "react";
import { PanelLeftOpenIcon } from "lucide-react";

import { DEFAULT_SHELL_SESSION_NAME } from "./TerminalSidebarItems";
import { useTerminalAppContext } from "./TerminalAppContext";

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
