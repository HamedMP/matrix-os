import { type TerminalFontFamily } from "@/stores/terminal-settings";

const NERD_FONT_FALLBACK = '"Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

const TERMINAL_FONT_STACKS = {
  "MesloLGS NF": '"MesloLGS NF"',
  "Berkeley Mono": '"Berkeley Mono", "Berkeley Mono Variable", "MesloLGS NF", "JetBrains Mono"',
  "JetBrains Mono": '"JetBrains Mono", "MesloLGS NF"',
  "Fira Code": '"Fira Code", "MesloLGS NF", "JetBrains Mono"',
} satisfies Record<TerminalFontFamily, string>;

export function buildTerminalFontStack(fontFamily: TerminalFontFamily, themeMono: string | undefined): string {
  const fallback = themeMono ? `${themeMono}, ${NERD_FONT_FALLBACK}` : NERD_FONT_FALLBACK;
  return `${TERMINAL_FONT_STACKS[fontFamily]}, ${fallback}`;
}
