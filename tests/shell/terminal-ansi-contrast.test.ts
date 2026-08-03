// @vitest-environment jsdom

import { Terminal, type IBufferCell, type ITheme } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import {
  getTerminalMinimumContrastRatio,
  getTerminalThemePreset,
  type AnsiPalette,
} from "../../shell/src/components/terminal/terminal-themes.js";

const ANSI_KEYS: (keyof AnsiPalette)[] = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

type TerminalTheme = ITheme & AnsiPalette & {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
};

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function cellAt(term: Terminal, row: number, column = 0): IBufferCell {
  const cell = term.buffer.active.getLine(row)?.getCell(column);
  if (!cell) throw new Error(`Missing terminal cell at ${row}:${column}`);
  return cell;
}

function paletteForeground(theme: TerminalTheme, cell: IBufferCell): string {
  if (cell.isFgDefault()) return theme.foreground;
  if (!cell.isFgPalette()) throw new Error("Expected a default or palette foreground");
  const color = ANSI_KEYS[cell.getFgColor()];
  if (!color) throw new Error(`Unsupported palette index ${cell.getFgColor()}`);
  return theme[color];
}

function relativeLuminance(color: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255);
  const [red = 0, green = 0, blue = 0] = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function composite(foreground: string, background: string): string {
  const alpha = Number.parseInt(foreground.slice(7, 9), 16) / 255;
  const channel = (offset: number) => Math.round(
    Number.parseInt(foreground.slice(offset, offset + 2), 16) * alpha
      + Number.parseInt(background.slice(offset, offset + 2), 16) * (1 - alpha),
  ).toString(16).padStart(2, "0");
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

describe("Matrix light terminal ANSI rendering", () => {
  it("parses default, SGR 30/34/90, palette index 0, reset, and reverse-video semantics", async () => {
    const theme = getTerminalThemePreset("light") as TerminalTheme;
    const terminal = new Terminal({
      allowProposedApi: true,
      cols: 80,
      rows: 24,
      minimumContrastRatio: getTerminalMinimumContrastRatio(theme),
      theme,
    });

    await write(terminal, [
      "D",
      "\x1b[30mK\x1b[0m",
      "\x1b[34mB\x1b[0m",
      "\x1b[90mG\x1b[0m",
      "\x1b[38;5;0mI\x1b[0m",
      "\x1b[30mX\x1b[0mR",
      "\x1b[7mV\x1b[27mN",
    ].join("\r\n"));

    const defaultCell = cellAt(terminal, 0);
    const blackCell = cellAt(terminal, 1);
    const blueCell = cellAt(terminal, 2);
    const brightBlackCell = cellAt(terminal, 3);
    const indexZeroCell = cellAt(terminal, 4);
    const resetCell = cellAt(terminal, 5, 1);
    const reverseCell = cellAt(terminal, 6);
    const reverseResetCell = cellAt(terminal, 6, 1);

    expect(defaultCell.isFgDefault()).toBe(true);
    expect(paletteForeground(theme, defaultCell)).toBe(theme.foreground);
    for (const cell of [blackCell, indexZeroCell]) {
      expect(cell.isFgPalette()).toBe(true);
      expect(cell.getFgColor()).toBe(0);
      expect(paletteForeground(theme, cell)).toBe(theme.black);
    }
    expect(blueCell.getFgColor()).toBe(4);
    expect(paletteForeground(theme, blueCell)).toBe(theme.blue);
    expect(brightBlackCell.getFgColor()).toBe(8);
    expect(paletteForeground(theme, brightBlackCell)).toBe(theme.brightBlack);
    expect(resetCell.isFgDefault()).toBe(true);
    expect(reverseCell.isInverse()).toBeTruthy();
    expect(reverseResetCell.isInverse()).toBeFalsy();
    const reversedForeground = reverseCell.isInverse() ? theme.background : theme.foreground;
    const reversedBackground = reverseCell.isInverse() ? theme.foreground : theme.background;
    expect(reversedForeground).toBe(theme.background);
    expect(reversedBackground).toBe(theme.foreground);
    expect(contrastRatio(reversedForeground, reversedBackground)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(theme.background, theme.foreground)).toBeGreaterThanOrEqual(4.5);

    expect(theme.selectionBackground).toMatch(/^#[0-9a-f]{8}$/i);
    const selectedBackground = composite(theme.selectionBackground, theme.background);
    expect(contrastRatio(theme.black, selectedBackground)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(theme.cursor, theme.background)).toBeGreaterThanOrEqual(3);
    terminal.dispose();
  });

  it("keeps the shipped cyan/blue prompt and explicit-black output visible together", async () => {
    const theme = getTerminalThemePreset("light") as TerminalTheme;
    const terminal = new Terminal({
      allowProposedApi: true,
      minimumContrastRatio: getTerminalMinimumContrastRatio(theme),
      theme,
    });

    await write(terminal, "\x1b[0;1;36mnima\x1b[0m:\x1b[0;1;34m~\x1b[0m$ \x1b[30mexplicit black\x1b[0m");
    const promptCyan = cellAt(terminal, 0, 0);
    const promptBlue = cellAt(terminal, 0, 5);
    const explicitBlack = cellAt(terminal, 0, 8);

    expect(promptCyan.isBold()).toBeTruthy();
    expect(promptCyan.getFgColor()).toBe(6);
    expect(promptBlue.isBold()).toBeTruthy();
    expect(promptBlue.getFgColor()).toBe(4);
    expect(explicitBlack.getFgColor()).toBe(0);
    for (const cell of [promptCyan, promptBlue, explicitBlack]) {
      expect(paletteForeground(theme, cell)).not.toBe(theme.background);
    }
    terminal.dispose();
  });
});
