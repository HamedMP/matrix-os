"use client";

/**
 * Compact mobile terminal keyboard.
 *
 * Collapsed mode is a one-row command strip. Expanded mode switches to a
 * fitted keyboard with ABC/Sym/Nav layers so phone users can type without
 * losing most of the terminal viewport or fighting horizontal clipping.
 */

import { useEffect, useState, type CSSProperties } from "react";

type KeyboardMode = "abc" | "sym" | "nav";

interface KeyDef {
  label: string;
  data: string;
  ariaLabel?: string;
  wide?: boolean;
}

const PRIMARY_KEYS: KeyDef[] = [
  { label: "Esc", data: "\x1b", ariaLabel: "Escape" },
  { label: "Tab", data: "\t", ariaLabel: "Tab" },
  { label: "Enter", data: "\r", ariaLabel: "Enter" },
  { label: "Ctrl+C", data: "\x03", ariaLabel: "Control C" },
  { label: "↑", data: "\x1b[A", ariaLabel: "Up arrow" },
  { label: "↓", data: "\x1b[B", ariaLabel: "Down arrow" },
  { label: "←", data: "\x1b[D", ariaLabel: "Left arrow" },
  { label: "→", data: "\x1b[C", ariaLabel: "Right arrow" },
];

const ABC_ROWS: KeyDef[][] = [
  "qwertyuiop".split("").map((letter) => ({ label: letter, data: letter, ariaLabel: `letter ${letter}` })),
  "asdfghjkl".split("").map((letter) => ({ label: letter, data: letter, ariaLabel: `letter ${letter}` })),
  [
    ...("zxcvbnm".split("").map((letter) => ({ label: letter, data: letter, ariaLabel: `letter ${letter}` }))),
    { label: "⌫", data: "\x7f", ariaLabel: "Backspace" },
  ],
  [
    { label: "Space", data: " ", ariaLabel: "Space", wide: true },
    { label: ".", data: "." },
    { label: "_", data: "_" },
    { label: "↵", data: "\r", ariaLabel: "Enter" },
  ],
];

const SYMBOL_ROWS: KeyDef[][] = [
  "1234567890".split("").map((char) => ({ label: char, data: char })),
  ["-", "_", "=", "+", ":", ";", "\"", "'", "`", "\\"].map((char) => ({ label: char, data: char })),
  ["$", "&", "*", "(", ")", "[", "]", "{", "}", "#"].map((char) => ({ label: char, data: char })),
  [
    { label: "/", data: "/" },
    { label: "|", data: "|" },
    { label: "~", data: "~" },
    { label: "@", data: "@" },
    { label: "!", data: "!" },
    { label: "?", data: "?" },
    { label: "⌫", data: "\x7f", ariaLabel: "Backspace" },
  ],
];

const NAV_ROWS: KeyDef[][] = [
  [
    { label: "Home", data: "\x1b[H", ariaLabel: "Home" },
    { label: "End", data: "\x1b[F", ariaLabel: "End" },
    { label: "PgUp", data: "\x1b[5~", ariaLabel: "Page up" },
    { label: "PgDn", data: "\x1b[6~", ariaLabel: "Page down" },
  ],
  [
    { label: "Ctrl+A", data: "\x01", ariaLabel: "Control A" },
    { label: "Ctrl+E", data: "\x05", ariaLabel: "Control E" },
    { label: "Ctrl+R", data: "\x12", ariaLabel: "Control R" },
    { label: "Ctrl+L", data: "\x0c", ariaLabel: "Control L" },
  ],
  [
    { label: "Ctrl+D", data: "\x04", ariaLabel: "Control D" },
    { label: "Ctrl+Z", data: "\x1a", ariaLabel: "Control Z" },
    { label: "Ctrl+U", data: "\x15", ariaLabel: "Control U" },
    { label: "Ctrl+K", data: "\x0b", ariaLabel: "Control K" },
  ],
];

interface TerminalKeyBarProps {
  onSend: (data: string) => void;
  background?: string;
  foreground?: string;
  accent?: string;
}

const MODE_LABELS: Record<KeyboardMode, string> = {
  abc: "ABC",
  sym: "Sym",
  nav: "Nav",
};

const KEY_BUTTON_BASE_STYLE: CSSProperties = {
  height: 34,
  minWidth: 34,
  borderRadius: 7,
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: 15,
  lineHeight: 1,
  cursor: "pointer",
  touchAction: "manipulation",
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
    // react-doctor-disable-next-line react-doctor/no-initialize-state -- viewport subscription: initial SSR-safe 0 is resynced once on mount and then from visualViewport callbacks.
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update, { passive: true });
    window.addEventListener("orientationchange", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return inset;
}

function rowsForMode(mode: KeyboardMode): KeyDef[][] {
  if (mode === "sym") return SYMBOL_ROWS;
  if (mode === "nav") return NAV_ROWS;
  return ABC_ROWS;
}

function compactWidthForKey(keyDef: KeyDef): number {
  if (keyDef.ariaLabel === "Enter") return 50;
  if (keyDef.ariaLabel === "Control C") return 56;
  if (keyDef.ariaLabel?.endsWith("arrow")) return 32;
  return 34;
}

export function TerminalKeyBar({
  onSend,
  background = "var(--background)",
  foreground = "var(--foreground)",
  accent = "var(--primary)",
}: TerminalKeyBarProps) {
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<KeyboardMode>("abc");
  const keyboardInset = useVisualViewportKeyboardInset();

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
        gap: 5,
        padding: "6px 5px max(6px, env(safe-area-inset-bottom))",
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
      {expanded ? (
        <>
          <div
            role="tablist"
            aria-label="Keyboard layers"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr)) auto",
              gap: 5,
            }}
          >
            {(Object.keys(MODE_LABELS) as KeyboardMode[]).map((nextMode) => (
              <button
                key={nextMode}
                type="button"
                role="tab"
                aria-selected={mode === nextMode}
                aria-label={`${MODE_LABELS[nextMode]} keyboard`}
                onClick={() => setMode(nextMode)}
                style={{
                  height: 30,
                  borderRadius: 7,
                  border: `1px solid ${mode === nextMode ? accent : buttonBorder}`,
                  background: mode === nextMode ? `color-mix(in srgb, ${accent} 24%, transparent)` : buttonBackground,
                  color: foreground,
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {MODE_LABELS[nextMode]}
              </button>
            ))}
            <button
              type="button"
              aria-label="Show fewer keys"
              onClick={() => setExpanded(false)}
              style={{
                height: 30,
                minWidth: 48,
                borderRadius: 7,
                border: `1px dashed ${accent}`,
                background: "transparent",
                color: mutedForeground,
                fontSize: 12,
                fontWeight: 650,
              }}
            >
              Less
            </button>
          </div>
          <KeyboardRows
            rows={rowsForMode(mode)}
            onSend={onSend}
            background={buttonBackground}
            foreground={foreground}
            border={buttonBorder}
          />
        </>
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 3,
            overflow: "hidden",
            WebkitOverflowScrolling: "touch",
            touchAction: "manipulation",
          }}
        >
          {PRIMARY_KEYS.map((keyDef) => (
            <TerminalKeyButton
              key={keyDef.ariaLabel ?? keyDef.label}
              keyDef={keyDef}
              onSend={onSend}
              background={buttonBackground}
              foreground={foreground}
              border={buttonBorder}
              compact
            />
          ))}
          <button
            type="button"
            aria-label="Show more keys"
            onClick={() => setExpanded(true)}
            style={{
              height: 34,
              width: 44,
              borderRadius: 7,
              border: `1px dashed ${accent}`,
              background: "transparent",
              color: mutedForeground,
              fontSize: 12,
              fontWeight: 650,
              flex: "0 0 44px",
              marginLeft: "auto",
            }}
          >
            More
          </button>
        </div>
      )}
    </div>
  );
}

function KeyboardRows({
  rows,
  onSend,
  background,
  foreground,
  border,
}: {
  rows: KeyDef[][];
  onSend: (data: string) => void;
  background: string;
  foreground: string;
  border: string;
}) {
  return (
    <div style={{ display: "grid", gap: 5 }}>
      {rows.map((row) => (
        <div
          key={row.map((keyDef) => keyDef.ariaLabel ?? keyDef.label).join("|")}
          style={{
            display: "grid",
            gridTemplateColumns: row.map((keyDef) => (keyDef.wide ? "minmax(112px, 3fr)" : "minmax(0, 1fr)")).join(" "),
            gap: 5,
            minWidth: 0,
          }}
        >
          {row.map((keyDef) => (
            <TerminalKeyButton
              key={keyDef.ariaLabel ?? keyDef.label}
              keyDef={keyDef}
              onSend={onSend}
              background={background}
              foreground={foreground}
              border={border}
              wide={keyDef.wide}
            />
          ))}
        </div>
      ))}
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
  compact,
}: {
  keyDef: KeyDef;
  onSend: (data: string) => void;
  background: string;
  foreground: string;
  border: string;
  wide?: boolean;
  compact?: boolean;
}) {
  const compactWidth = compact ? compactWidthForKey(keyDef) : undefined;
  return (
    <button
      type="button"
      aria-label={keyDef.ariaLabel ?? keyDef.label}
      onPointerDown={(e) => {
        e.preventDefault();
        onSend(keyDef.data);
      }}
      style={{
        ...KEY_BUTTON_BASE_STYLE,
        minWidth: compact ? 0 : wide ? 112 : 34,
        width: compactWidth,
        background,
        color: foreground,
        border: `1px solid ${border}`,
        flex: compact ? `0 0 ${compactWidth}px` : "0 0 auto",
        padding: compact ? 0 : undefined,
        fontWeight: wide ? 700 : 650,
      }}
    >
      {keyDef.label}
    </button>
  );
}
