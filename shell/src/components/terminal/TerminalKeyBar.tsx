"use client";

/**
 * Compact mobile terminal keyboard (spec 102 — terminal mobile polish).
 *
 * Collapsed mode is a one-row, horizontally-scrollable command strip. Expanded
 * mode switches to a fitted keyboard with ABC/Sym/Nav layers so phone users can
 * type without losing most of the terminal viewport or fighting horizontal
 * clipping.
 *
 * Styling is driven by brand tokens (radius / elevation / emphasized easing)
 * layered on the terminal chrome colors passed in as props, so the bar always
 * matches the active terminal theme. Pressed/active states, ≥44px touch targets
 * and a paste affordance (clipboard read + iOS <input> fallback) live here.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ClipboardPasteIcon } from "lucide-react";

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

const MODE_LABELS: Record<KeyboardMode, string> = {
  abc: "ABC",
  sym: "Sym",
  nav: "Nav",
};

// Bracketed-paste so multi-line clipboard content lands on the prompt as a
// single literal block (no implicit execution) — the user reviews it before
// pressing Enter. Mirrors the terminal pane's paste handling.
const BRACKETED_PASTE_OPEN = "\x1b[200~";
const BRACKETED_PASTE_CLOSE = "\x1b[201~";
const MAX_PASTE_LENGTH = 65_536 - BRACKETED_PASTE_OPEN.length - BRACKETED_PASTE_CLOSE.length;
const LONG_PRESS_MS = 450;

// Brand-token-driven styling for the whole bar. Scoped under .mtk-bar so it
// never leaks; colors resolve from per-instance --mtk-* vars set from props.
const KEYBAR_CSS = `
.mtk-bar {
  --mtk-key-bg: color-mix(in srgb, var(--mtk-fg) 9%, transparent);
  --mtk-key-bg-press: color-mix(in srgb, var(--mtk-accent) 26%, transparent);
  --mtk-key-border: color-mix(in srgb, var(--mtk-fg) 16%, transparent);
  --mtk-muted: color-mix(in srgb, var(--mtk-fg) 62%, transparent);
}
.mtk-key,
.mtk-tab,
.mtk-ghost {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 44px;
  border-radius: var(--radius-sm, 8px);
  font-family: var(--font-mono, ui-monospace, monospace);
  line-height: 1;
  cursor: pointer;
  touch-action: manipulation;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  transition:
    transform 140ms var(--ease-emphasized, ease),
    background-color 140ms var(--ease-emphasized, ease),
    border-color 140ms var(--ease-emphasized, ease);
}
.mtk-key {
  min-width: 36px;
  padding: 0 6px;
  border: 1px solid var(--mtk-key-border);
  background: var(--mtk-key-bg);
  color: var(--mtk-fg);
  font-size: 15px;
  font-weight: 650;
}
.mtk-key:active {
  transform: scale(0.93);
  background: var(--mtk-key-bg-press);
  border-color: color-mix(in srgb, var(--mtk-accent) 55%, transparent);
}
.mtk-key--wide { font-weight: 700; }
.mtk-key--accent {
  border-color: color-mix(in srgb, var(--mtk-accent) 60%, transparent);
  background: color-mix(in srgb, var(--mtk-accent) 18%, transparent);
}
.mtk-tab {
  padding: 0 8px;
  border: 1px solid var(--mtk-key-border);
  background: var(--mtk-key-bg);
  color: var(--mtk-fg);
  font-size: 12px;
  font-weight: 700;
}
.mtk-tab[aria-selected="true"] {
  border-color: color-mix(in srgb, var(--mtk-accent) 70%, transparent);
  background: color-mix(in srgb, var(--mtk-accent) 24%, transparent);
}
.mtk-tab:active { transform: scale(0.95); }
.mtk-ghost {
  min-width: 48px;
  padding: 0 10px;
  border: 1px dashed color-mix(in srgb, var(--mtk-accent) 55%, transparent);
  background: transparent;
  color: var(--mtk-muted);
  font-size: 12px;
  font-weight: 650;
}
.mtk-ghost:active { transform: scale(0.95); }
.mtk-scroll {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
.mtk-scroll::-webkit-scrollbar { display: none; }
@media (prefers-reduced-motion: reduce) {
  .mtk-key,
  .mtk-tab,
  .mtk-ghost { transition: none; }
  .mtk-key:active,
  .mtk-tab:active,
  .mtk-ghost:active { transform: none; }
}
`;

interface TerminalKeyBarProps {
  onSend: (data: string) => void;
  background?: string;
  foreground?: string;
  accent?: string;
  compactOnly?: boolean;
}

function rowsForMode(mode: KeyboardMode): KeyDef[][] {
  if (mode === "sym") return SYMBOL_ROWS;
  if (mode === "nav") return NAV_ROWS;
  return ABC_ROWS;
}

function compactFlexForKey(keyDef: KeyDef): string {
  if (keyDef.ariaLabel === "Enter") return "0 0 56px";
  if (keyDef.ariaLabel === "Control C") return "0 0 60px";
  if (keyDef.ariaLabel?.endsWith("arrow")) return "0 0 40px";
  return "0 0 44px";
}

export function TerminalKeyBar({
  onSend,
  background = "var(--background)",
  foreground = "var(--foreground)",
  accent = "var(--primary)",
  compactOnly = false,
}: TerminalKeyBarProps) {
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<KeyboardMode>("abc");
  const [pasteFallbackOpen, setPasteFallbackOpen] = useState(false);
  const pasteInputRef = useRef<HTMLInputElement>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedRef = useRef(false);

  useEffect(() => {
    if (!compactOnly) return;
    setExpanded(false);
    setPasteFallbackOpen(false);
  }, [compactOnly]);

  // react-doctor-disable-next-line react-doctor/exhaustive-deps -- unmount cleanup must clear the latest long-press timeout ref; capturing the initial value would leak timers created after mount
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    };
  }, []);

  const sendPaste = (text: string) => {
    const safe = text.replace(/\x1b\[20[01]~/g, "").slice(0, MAX_PASTE_LENGTH);
    if (!safe) return;
    // No trailing Enter — bracketed paste drops the block onto the prompt for
    // the user to review and send themselves.
    onSend(`${BRACKETED_PASTE_OPEN}${safe}${BRACKETED_PASTE_CLOSE}`);
  };

  const runClipboardPaste = () => {
    // navigator.clipboard is undefined on insecure-origin mobile browsers and
    // WebViews with a denied clipboard policy; fall back to a manual <input>.
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard?.readText) {
      setPasteFallbackOpen(true);
      return;
    }
    clipboard
      .readText()
      .then((text) => {
        if (text) {
          sendPaste(text);
        } else {
          setPasteFallbackOpen(true);
        }
      })
      .catch((err: unknown) => {
        console.warn("[TerminalKeyBar] clipboard read failed:", err instanceof Error ? err.message : typeof err);
        setPasteFallbackOpen(true);
      });
  };

  const cancelLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handlePastePointerDown = () => {
    longPressedRef.current = false;
    cancelLongPress();
    longPressTimerRef.current = setTimeout(() => {
      longPressedRef.current = true;
      setPasteFallbackOpen(true);
    }, LONG_PRESS_MS);
  };

  const handlePasteClick = () => {
    cancelLongPress();
    // Long-press already opened the manual fallback; don't also read clipboard.
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    runClipboardPaste();
  };

  const submitPasteFallback = () => {
    const input = pasteInputRef.current;
    if (input && input.value) {
      sendPaste(input.value);
      input.value = "";
    }
    setPasteFallbackOpen(false);
  };

  const barStyle = {
    "--mtk-bg": background,
    "--mtk-fg": foreground,
    "--mtk-accent": accent,
    display: "flex",
    alignItems: "stretch",
    flexDirection: "column",
    gap: 6,
    padding: "7px 6px max(7px, env(safe-area-inset-bottom))",
    position: "sticky",
    bottom: 0,
    zIndex: 5,
    background: "var(--mtk-bg)",
    borderTop: "1px solid color-mix(in srgb, var(--mtk-fg) 16%, transparent)",
    overflow: "hidden",
    flexShrink: 0,
    touchAction: "none",
    WebkitOverflowScrolling: "touch",
    boxShadow: "var(--elevation-3, 0 -10px 20px color-mix(in srgb, var(--mtk-bg) 70%, transparent))",
  } as CSSProperties & Record<"--mtk-bg" | "--mtk-fg" | "--mtk-accent", string>;

  return (
    <div
      className="mtk-bar"
      role="toolbar"
      aria-label="Terminal accessory keys"
      data-testid="terminal-key-bar"
      style={barStyle}
    >
      <style>{KEYBAR_CSS}</style>

      {pasteFallbackOpen && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            ref={pasteInputRef}
            aria-label="Paste text"
            placeholder="Long-press here, paste, then Send"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            // 16px keeps iOS Safari from zooming the viewport on focus.
            style={{
              flex: "1 1 auto",
              minWidth: 0,
              height: 44,
              padding: "0 12px",
              borderRadius: "var(--radius-sm, 8px)",
              border: "1px solid color-mix(in srgb, var(--mtk-fg) 18%, transparent)",
              background: "color-mix(in srgb, var(--mtk-fg) 8%, transparent)",
              color: "var(--mtk-fg)",
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              fontSize: 16,
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitPasteFallback();
              }
            }}
          />
          <button type="button" className="mtk-key mtk-key--accent" onPointerDown={(e) => e.preventDefault()} onClick={submitPasteFallback}>
            Send
          </button>
          <button
            type="button"
            className="mtk-ghost"
            aria-label="Cancel paste"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => setPasteFallbackOpen(false)}
          >
            Cancel
          </button>
        </div>
      )}

      {expanded && !compactOnly ? (
        <>
          <div
            role="tablist"
            aria-label="Keyboard layers"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr)) auto auto",
              gap: 6,
            }}
          >
            {(Object.keys(MODE_LABELS) as KeyboardMode[]).map((nextMode) => (
              <button
                key={nextMode}
                type="button"
                role="tab"
                className="mtk-tab"
                aria-selected={mode === nextMode}
                aria-label={`${MODE_LABELS[nextMode]} keyboard`}
                onClick={() => setMode(nextMode)}
              >
                {MODE_LABELS[nextMode]}
              </button>
            ))}
            <button
              type="button"
              className="mtk-tab"
              aria-label="Paste from clipboard"
              onPointerDown={handlePastePointerDown}
              onPointerUp={cancelLongPress}
              onPointerLeave={cancelLongPress}
              onPointerCancel={cancelLongPress}
              onClick={handlePasteClick}
            >
              <ClipboardPasteIcon size={15} strokeWidth={1.9} aria-hidden="true" />
              Paste
            </button>
            <button type="button" className="mtk-ghost" aria-label="Show fewer keys" onClick={() => setExpanded(false)}>
              Less
            </button>
          </div>
          <KeyboardRows rows={rowsForMode(mode)} onSend={onSend} />
        </>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {/* Keys scroll horizontally when they overflow; the Paste + More
              buttons are fixed-width siblings outside the scroll area so they
              stay fully tappable on narrow (<=360px) viewports. */}
          <div
            className="mtk-scroll"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              flex: "1 1 auto",
              minWidth: 0,
              overflowX: "auto",
              WebkitOverflowScrolling: "touch",
              touchAction: "pan-x",
            }}
          >
            {PRIMARY_KEYS.map((keyDef) => (
              <button
                key={keyDef.ariaLabel ?? keyDef.label}
                type="button"
                className="mtk-key"
                aria-label={keyDef.ariaLabel ?? keyDef.label}
                style={{ flex: compactFlexForKey(keyDef) }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  onSend(keyDef.data);
                }}
              >
                {keyDef.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="mtk-key mtk-key--accent"
            aria-label="Paste from clipboard"
            style={{ flex: "0 0 auto", minWidth: 44, padding: "0 12px", fontSize: 13 }}
            onPointerDown={handlePastePointerDown}
            onPointerUp={cancelLongPress}
            onPointerLeave={cancelLongPress}
            onPointerCancel={cancelLongPress}
            onClick={handlePasteClick}
          >
            <ClipboardPasteIcon size={16} strokeWidth={1.9} aria-hidden="true" />
          </button>
          {!compactOnly ? (
            <button
              type="button"
              className="mtk-ghost"
              aria-label="Show more keys"
              style={{ flex: "0 0 auto" }}
              onClick={() => setExpanded(true)}
            >
              More
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function KeyboardRows({ rows, onSend }: { rows: KeyDef[][]; onSend: (data: string) => void }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {rows.map((row) => (
        <div
          key={row.map((keyDef) => keyDef.ariaLabel ?? keyDef.label).join("|")}
          style={{
            display: "grid",
            gridTemplateColumns: row.map((keyDef) => (keyDef.wide ? "minmax(112px, 3fr)" : "minmax(0, 1fr)")).join(" "),
            gap: 6,
            minWidth: 0,
          }}
        >
          {row.map((keyDef) => (
            <button
              key={keyDef.ariaLabel ?? keyDef.label}
              type="button"
              className={keyDef.wide ? "mtk-key mtk-key--wide" : "mtk-key"}
              aria-label={keyDef.ariaLabel ?? keyDef.label}
              style={{ minWidth: 0 }}
              onPointerDown={(e) => {
                e.preventDefault();
                onSend(keyDef.data);
              }}
            >
              {keyDef.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
