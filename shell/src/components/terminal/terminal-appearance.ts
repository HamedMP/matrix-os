export interface TerminalAppearanceTarget {
  element?: HTMLElement;
  rows: number;
  options: {
    theme: unknown;
    fontFamily: string;
    fontSize: number;
    cursorBlink: boolean;
    cursorStyle: "block" | "bar" | "underline";
    smoothScrollDuration: number;
  };
  refresh: (start: number, end: number) => void;
}

export interface TerminalFitTarget {
  fit: () => void;
}

interface TerminalAppearanceOptions {
  theme: unknown;
  fontFamily: string;
  fontSize: number;
  cursorBlink: boolean;
  cursorStyle: "block" | "bar" | "underline";
  smoothScrollDuration: number;
  ligatures: boolean;
}

export function applyTerminalAppearance(
  term: TerminalAppearanceTarget,
  fitAddon: TerminalFitTarget,
  options: TerminalAppearanceOptions,
): void {
  term.options.theme = options.theme;
  term.options.fontFamily = options.fontFamily;
  term.options.fontSize = options.fontSize;
  term.options.cursorBlink = options.cursorBlink;
  term.options.cursorStyle = options.cursorStyle;
  term.options.smoothScrollDuration = options.smoothScrollDuration;
  if (term.element) {
    term.element.style.fontVariantLigatures = options.ligatures ? "normal" : "none";
  }
  fitAddon.fit();
  if (term.rows > 0) {
    term.refresh(0, term.rows - 1);
  }
}
