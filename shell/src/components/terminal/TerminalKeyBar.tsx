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

import { useEffect, useState, type CSSProperties } from "react";

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
  { label: "Enter", data: "\r", primary: true, ariaLabel: "Enter" },
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

const KEYBOARD_ROWS: KeyDef[][] = [
  "qwertyuiop".split("").map((letter) => ({ label: letter, data: letter, ariaLabel: `letter ${letter}` })),
  "asdfghjkl".split("").map((letter) => ({ label: letter, data: letter, ariaLabel: `letter ${letter}` })),
  [
    ...("zxcvbnm".split("").map((letter) => ({ label: letter, data: letter, ariaLabel: `letter ${letter}` }))),
    { label: "⌫", data: "\x7f", ariaLabel: "Backspace" },
  ],
  [
    { label: "Space", data: " ", ariaLabel: "Space" },
    { label: ".", data: "." },
    { label: "_", data: "_" },
  ],
];

interface TerminalKeyBarProps {
  onSend: (data: string) => void;
  background?: string;
  foreground?: string;
  accent?: string;
}

const MORE_BUTTON_STYLE: CSSProperties = {
  fontSize: 13,
  padding: "8px 10px",
  background: "transparent",
  borderRadius: 6,
  minWidth: 36,
  flexShrink: 0,
  marginLeft: "auto",
};

const KEY_BUTTON_BASE_STYLE: CSSProperties = {
  fontSize: 13,
  lineHeight: 1,
  padding: "8px 10px",
  borderRadius: 6,
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  cursor: "pointer",
};

function readVisualViewportKeyboardInset(): number {
  if (typeof window === "undefined" || !window.visualViewport) return 0;
  const inset = window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop;
  return Math.max(0, Math.round(inset));
}

function useVisualViewportKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const viewport = window.visualViewport;
    const update = () => setInset(readVisualViewportKeyboardInset());
    // react-doctor-disable-next-line react-doctor/no-initialize-state -- not an initializer: `inset` is seeded to 0 (SSR-safe, no visualViewport on the server) and this mount call re-syncs it against the live VisualViewport once on the client; it is the same handler subscribed to resize/scroll/orientationchange below, so this is a viewport subscription, not state initialization.
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("orientationchange", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return inset;
}

export function TerminalKeyBar({
  onSend,
  background = "var(--background)",
  foreground = "var(--foreground)",
  accent = "var(--primary)",
}: TerminalKeyBarProps) {
  const [expanded, setExpanded] = useState(false);
  const keyboardInset = useVisualViewportKeyboardInset();

  const visible = KEYS.filter((k) => expanded || k.primary);
  const buttonBackground = `color-mix(in srgb, ${foreground} 10%, transparent)`;
  const buttonBorder = `color-mix(in srgb, ${foreground} 18%, transparent)`;
  const mutedForeground = `color-mix(in srgb, ${foreground} 66%, transparent)`;
  const bottomInset = keyboardInset > 0 ? `${keyboardInset}px` : "env(keyboard-inset-height, 0px)";

  return (
    <div
      role="toolbar"
      aria-label="Terminal accessory keys"
      data-testid="terminal-key-bar"
      style={{
        "--matrix-terminal-keybar-bottom": bottomInset,
        display: "flex",
        alignItems: "stretch",
        flexDirection: "column",
        gap: 4,
        padding: "6px 4px max(6px, env(safe-area-inset-bottom))",
        position: "sticky",
        bottom: "var(--matrix-terminal-keybar-bottom)",
        zIndex: 5,
        background,
        borderTop: `1px solid ${buttonBorder}`,
        overflow: "hidden",
        flexShrink: 0,
        touchAction: "none",
        WebkitOverflowScrolling: "touch",
        boxShadow: `0 -10px 20px color-mix(in srgb, ${background} 70%, transparent)`,
      } as CSSProperties & Record<"--matrix-terminal-keybar-bottom", string>}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          overflowX: "auto",
          WebkitOverflowScrolling: "touch",
          touchAction: "pan-x",
        }}
      >
        {visible.map((k) => (
          <TerminalKeyButton
            key={k.label}
            keyDef={k}
            onSend={onSend}
            background={buttonBackground}
            foreground={foreground}
            border={buttonBorder}
          />
        ))}
        <button
          type="button"
          aria-label={expanded ? "Show fewer keys" : "Show more keys"}
          onClick={() => setExpanded((v) => !v)}
          style={{
            ...MORE_BUTTON_STYLE,
            color: mutedForeground,
            border: `1px dashed ${accent}`,
          }}
        >
          {expanded ? "Less" : "More"}
        </button>
      </div>
      {expanded && (
        <div style={{ display: "grid", gap: 4 }}>
          {KEYBOARD_ROWS.map((row, index) => (
            <div
              key={index}
              style={{
                display: "flex",
                justifyContent: "center",
                gap: 4,
                minWidth: 0,
              }}
            >
              {row.map((k) => (
                <TerminalKeyButton
                  key={k.ariaLabel ?? k.label}
                  keyDef={k}
                  onSend={onSend}
                  background={buttonBackground}
                  foreground={foreground}
                  border={buttonBorder}
                  wide={k.label === "Space"}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TerminalKeyButton({
  keyDef,
  onSend,
  background,
  foreground,
  border,
  wide,
}: {
  keyDef: KeyDef;
  onSend: (data: string) => void;
  background: string;
  foreground: string;
  border: string;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={keyDef.ariaLabel ?? keyDef.label}
      onPointerDown={(e) => {
        // Send on pointer-down for responsiveness (matches Termius). Block
        // the default to keep xterm focus and prevent the native keyboard.
        e.preventDefault();
        onSend(keyDef.data);
      }}
      style={{
        ...KEY_BUTTON_BASE_STYLE,
        background,
        color: foreground,
        border: `1px solid ${border}`,
        minWidth: wide ? 112 : 36,
        flex: wide ? "0 1 160px" : "0 0 auto",
      }}
    >
      {keyDef.label}
    </button>
  );
}
