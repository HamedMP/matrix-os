"use client";

/**
 * Termius-style accessory key bar that sits between the xterm and the
 * software keyboard on phones. Each tap sends a raw escape sequence to the
 * focused pane's PTY via the parent-provided `onSend` callback.
 *
 * Scope:
 * - v1 sends complete sequences per tap (no "armed modifier + next key"
 *   chord state). Buttons like Ctrl+C / Ctrl+D / Ctrl+Z are single taps.
 * - Two horizontally-scrollable rows; the second row is "More..." gated so
 *   the bar stays one row tall by default.
 */

import { useState } from "react";

interface KeyDef {
  label: string;
  data: string;
  /** Whether to keep this key on the always-visible row. */
  primary?: boolean;
  /** Optional ARIA label for screen readers / e2e selectors. */
  ariaLabel?: string;
}

const KEYS: KeyDef[] = [
  { label: "Esc", data: "\x1b", primary: true, ariaLabel: "Escape" },
  { label: "Tab", data: "\t", primary: true, ariaLabel: "Tab" },
  { label: "Ctrl+C", data: "\x03", primary: true, ariaLabel: "Control C" },
  { label: "↑", data: "\x1b[A", primary: true, ariaLabel: "Up arrow" },
  { label: "↓", data: "\x1b[B", primary: true, ariaLabel: "Down arrow" },
  { label: "←", data: "\x1b[D", primary: true, ariaLabel: "Left arrow" },
  { label: "→", data: "\x1b[C", primary: true, ariaLabel: "Right arrow" },
  { label: "/", data: "/", primary: true },
  { label: "|", data: "|", primary: true },
  { label: "~", data: "~", primary: true },
  { label: "-", data: "-" },
  { label: ":", data: ":" },
  { label: "Home", data: "\x1b[H", ariaLabel: "Home" },
  { label: "End", data: "\x1b[F", ariaLabel: "End" },
  { label: "PgUp", data: "\x1b[5~", ariaLabel: "Page up" },
  { label: "PgDn", data: "\x1b[6~", ariaLabel: "Page down" },
  { label: "Ctrl+D", data: "\x04", ariaLabel: "Control D" },
  { label: "Ctrl+Z", data: "\x1a", ariaLabel: "Control Z" },
  { label: "Ctrl+L", data: "\x0c", ariaLabel: "Control L" },
  { label: "Ctrl+A", data: "\x01", ariaLabel: "Control A" },
  { label: "Ctrl+E", data: "\x05", ariaLabel: "Control E" },
  { label: "Ctrl+R", data: "\x12", ariaLabel: "Control R" },
];

interface TerminalKeyBarProps {
  onSend: (data: string) => void;
}

export function TerminalKeyBar({ onSend }: TerminalKeyBarProps) {
  const [expanded, setExpanded] = useState(false);

  const visible = expanded ? KEYS : KEYS.filter((k) => k.primary);

  return (
    <div
      role="toolbar"
      aria-label="Terminal accessory keys"
      data-testid="terminal-key-bar"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "6px 4px",
        background: "rgba(0,0,0,0.45)",
        borderTop: "1px solid rgba(244,237,224,0.08)",
        overflowX: "auto",
        flexShrink: 0,
        touchAction: "pan-x",
        WebkitOverflowScrolling: "touch",
      }}
    >
      {visible.map((k) => (
        <button
          key={k.label}
          type="button"
          aria-label={k.ariaLabel ?? k.label}
          onPointerDown={(e) => {
            // Send on pointer-down for responsiveness (matches Termius). Block
            // the default to keep the xterm from losing focus to the bar.
            e.preventDefault();
            onSend(k.data);
          }}
          style={{
            fontSize: 13,
            lineHeight: 1,
            padding: "8px 10px",
            background: "rgba(244,237,224,0.08)",
            color: "var(--foreground, #f4ede0)",
            border: "1px solid rgba(244,237,224,0.12)",
            borderRadius: 6,
            minWidth: 36,
            flexShrink: 0,
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            cursor: "pointer",
          }}
        >
          {k.label}
        </button>
      ))}
      <button
        type="button"
        aria-label={expanded ? "Show fewer keys" : "Show more keys"}
        onClick={() => setExpanded((v) => !v)}
        style={{
          fontSize: 13,
          padding: "8px 10px",
          background: "transparent",
          color: "var(--muted-foreground, rgba(244,237,224,0.6))",
          border: "1px dashed rgba(244,237,224,0.12)",
          borderRadius: 6,
          minWidth: 36,
          flexShrink: 0,
          marginLeft: "auto",
        }}
      >
        {expanded ? "Less" : "More"}
      </button>
    </div>
  );
}
