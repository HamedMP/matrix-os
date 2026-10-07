import "./terminal-session-header.css";
import { SquareTerminal } from "@renderer/lib/hugeicons";
import type { ComponentProps, ReactNode, Ref } from "react";
import { DesktopNewSessionControl } from "./DesktopNewSessionControl";
import { DesktopTerminalThemePicker } from "./DesktopTerminalThemePicker";

/** The arrow describes the action: left hides the left sidebar, right reveals it. */
export function TerminalSidebarToggle({
  shown,
  sidebarId,
  buttonRef,
  onToggle,
}: {
  shown: boolean;
  sidebarId: string;
  buttonRef?: Ref<HTMLButtonElement>;
  onToggle: () => void;
}) {
  const label = shown ? "Hide terminal tabs" : "Show terminal tabs";
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      title={label}
      aria-controls={sidebarId}
      aria-expanded={shown}
      className="no-drag flex size-9 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      onClick={onToggle}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        data-direction={shown ? "left" : "right"}
      >
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M8 4v16" />
        <path d={shown ? "m16 9-3 3 3 3" : "m13 9 3 3-3 3"} />
      </svg>
    </button>
  );
}

export function TerminalSessionHeader({
  shown = true,
  sidebarId,
  buttonRef,
  onToggle,
  ...creation
}: ComponentProps<typeof DesktopNewSessionControl> & {
  shown?: boolean;
  sidebarId: string;
  buttonRef?: Ref<HTMLButtonElement>;
  onToggle: () => void;
}) {
  return (
    <div className="flex h-12 w-[280px] shrink-0 items-center justify-between gap-2 px-4">
      <div className="flex min-w-0 items-center gap-1.5">
        <SquareTerminal size={16} aria-hidden="true" />
        <h1
          className="truncate text-base font-medium tracking-[-0.4px]"
          style={{ color: "var(--text-primary)" }}
        >
          Terminal
        </h1>
      </div>
      <div
        data-terminal-sidebar-header-actions
        className="no-drag flex shrink-0 items-center gap-2"
      >
        <TerminalSidebarToggle
          shown={shown}
          sidebarId={sidebarId}
          buttonRef={buttonRef}
          onToggle={onToggle}
        />
        <DesktopTerminalThemePicker />
        <DesktopNewSessionControl {...creation} />
      </div>
    </div>
  );
}

export function TerminalSessionDetails({
  name,
  subtitle,
  status,
  controlsRef,
  actions,
}: {
  name?: string;
  subtitle?: string;
  status?: string;
  controlsRef: Ref<HTMLDivElement>;
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-between gap-3 px-4">
      <div data-terminal-header-session className="min-w-0 flex-1">
        {name && (
          <>
            <h1
              title={name}
              className="truncate text-xs font-medium leading-[19.5px]"
              style={{ color: "var(--text-primary)" }}
            >
              {name}
            </h1>
            <p
              title={subtitle}
              className="truncate text-xs leading-4 tracking-[0.12px]"
              style={{ color: "var(--text-tertiary)" }}
            >
              {subtitle}
            </p>
          </>
        )}
      </div>
      <div
        data-terminal-header-actions
        className="no-drag relative flex shrink-0 items-center gap-2"
      >
        {status && (
          <span
            data-terminal-header-status
            className="inline-flex h-5 items-center justify-center rounded-[26px] border px-2 py-0.5 text-xs font-medium leading-4"
            style={{
              borderColor: "var(--border-subtle)",
              background: "var(--bg-selected)",
              color:
                status === "Active" ? "var(--success)" : "var(--text-tertiary)",
            }}
          >
            {status}
          </span>
        )}
        {actions}
        <div
          ref={controlsRef}
          data-terminal-controls-host
          className="no-drag"
        />
      </div>
    </div>
  );
}
