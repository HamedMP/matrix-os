import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import {
  extractTerminalLinkMatches,
  resolveTerminalLink,
  type TerminalClipboardResult,
  type TerminalLinkEntry,
} from "@matrix-os/contracts";

export type { TerminalLinkEntry } from "@matrix-os/contracts";

export interface DesktopTerminalCellPosition {
  bufferLineNumber: number;
  column: number;
}

interface WrappedLineInfo {
  text: string;
  startRow: number;
  lineLengths: number[];
}

function getWrappedLine(
  terminal: Pick<Terminal, "buffer">,
  bufferRow: number,
): WrappedLineInfo | null {
  const buffer = terminal.buffer.active;
  if (!buffer.getLine(bufferRow)) return null;

  let startRow = bufferRow;
  while (startRow > 0) {
    const current = buffer.getLine(startRow);
    if (!current?.isWrapped) break;
    startRow -= 1;
  }

  const parts: string[] = [];
  const lineLengths: number[] = [];
  for (let row = startRow; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (!line || (row > startRow && !line.isWrapped)) break;
    const text = line.translateToString();
    parts.push(text);
    lineLengths.push(text.length);
  }

  return { text: parts.join(""), startRow, lineLengths };
}

function offsetToCell(
  lineLengths: number[],
  startRow: number,
  offset: number,
): DesktopTerminalCellPosition {
  let remaining = offset;
  for (let index = 0; index < lineLengths.length; index += 1) {
    const lineLength = lineLengths[index] ?? 0;
    if (remaining < lineLength) {
      return {
        bufferLineNumber: startRow + index + 1,
        column: remaining + 1,
      };
    }
    remaining -= lineLength;
  }

  const lastIndex = Math.max(0, lineLengths.length - 1);
  return {
    bufferLineNumber: startRow + lastIndex + 1,
    column: Math.max(1, lineLengths[lastIndex] ?? 1),
  };
}

function cellIsWithinRange(
  cell: DesktopTerminalCellPosition,
  start: DesktopTerminalCellPosition,
  end: DesktopTerminalCellPosition,
): boolean {
  const afterStart =
    cell.bufferLineNumber > start.bufferLineNumber
    || (cell.bufferLineNumber === start.bufferLineNumber && cell.column >= start.column);
  const beforeEnd =
    cell.bufferLineNumber < end.bufferLineNumber
    || (cell.bufferLineNumber === end.bufferLineNumber && cell.column <= end.column);
  return afterStart && beforeEnd;
}

export function resolveDesktopTerminalLink(rawUrl: string): TerminalLinkEntry | null {
  return resolveTerminalLink(rawUrl);
}

export function openDesktopTerminalLink(link: TerminalLinkEntry): void {
  window.open(link.url, "_blank", "noopener,noreferrer");
}

function fallbackCopy(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    return typeof document.execCommand === "function" && document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

function tryFallbackCopy(text: string): TerminalClipboardResult {
  try {
    return fallbackCopy(text) ? "success" : "unavailable";
  } catch (error: unknown) {
    console.warn("[terminal] fallback clipboard copy unavailable", {
      category: error instanceof DOMException ? error.name : "clipboard-error",
    });
    return "unavailable";
  }
}

export async function copyDesktopTerminalText(text: string): Promise<TerminalClipboardResult> {
  if (text.length === 0) return "empty";
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return "success";
    } catch (error: unknown) {
      console.warn("[terminal] clipboard copy unavailable; trying fallback", {
        category: error instanceof DOMException ? error.name : "clipboard-error",
      });
    }
  }
  return tryFallbackCopy(text);
}

export function copyDesktopTerminalLink(link: TerminalLinkEntry): Promise<TerminalClipboardResult> {
  return copyDesktopTerminalText(link.url);
}

export function activateDesktopTerminalLink(
  event: Pick<MouseEvent, "button">,
  rawUrl: string,
): void {
  if (event.button !== 0) return;
  const link = resolveDesktopTerminalLink(rawUrl);
  if (link) openDesktopTerminalLink(link);
}

export function desktopTerminalCellFromPointer(
  terminal: Pick<Terminal, "cols" | "rows" | "element" | "buffer">,
  clientX: number,
  clientY: number,
): DesktopTerminalCellPosition | null {
  const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!screen || terminal.cols <= 0 || terminal.rows <= 0) return null;
  const rect = screen.getBoundingClientRect();
  if (
    rect.width <= 0
    || rect.height <= 0
    || clientX < rect.left
    || clientX >= rect.right
    || clientY < rect.top
    || clientY >= rect.bottom
  ) {
    return null;
  }

  const column = Math.floor(((clientX - rect.left) / rect.width) * terminal.cols) + 1;
  const viewportRow = Math.floor(((clientY - rect.top) / rect.height) * terminal.rows) + 1;
  return {
    column,
    bufferLineNumber: terminal.buffer.active.viewportY + viewportRow,
  };
}

export function findDesktopTerminalLinkAtCell(
  terminal: Pick<Terminal, "buffer">,
  cell: DesktopTerminalCellPosition,
): TerminalLinkEntry | null {
  const wrapped = getWrappedLine(terminal, cell.bufferLineNumber - 1);
  if (!wrapped) return null;

  for (const match of extractTerminalLinkMatches(wrapped.text)) {
    const start = offsetToCell(wrapped.lineLengths, wrapped.startRow, match.startIndex);
    const end = offsetToCell(
      wrapped.lineLengths,
      wrapped.startRow,
      match.startIndex + match.text.length - 1,
    );
    if (cellIsWithinRange(cell, start, end)) return match.entry;
  }
  return null;
}

export function findDesktopTerminalLinkAtPointer(
  terminal: Pick<Terminal, "cols" | "rows" | "element" | "buffer">,
  clientX: number,
  clientY: number,
  fallbackLink: TerminalLinkEntry | null = null,
): TerminalLinkEntry | null {
  const cell = desktopTerminalCellFromPointer(terminal, clientX, clientY);
  return (cell ? findDesktopTerminalLinkAtCell(terminal, cell) : null) ?? fallbackLink;
}

export class DesktopWebLinkProvider implements ILinkProvider {
  constructor(
    private readonly terminal: Pick<Terminal, "buffer">,
    private readonly onHover?: (link: TerminalLinkEntry | null) => void,
  ) {}

  provideLinks(
    bufferLineNumber: number,
    callback: (links: ILink[] | undefined) => void,
  ): void {
    const wrapped = getWrappedLine(this.terminal, bufferLineNumber - 1);
    if (!wrapped || wrapped.startRow !== bufferLineNumber - 1) {
      callback(undefined);
      return;
    }

    const links = extractTerminalLinkMatches(wrapped.text).map<ILink>((match) => {
      const start = offsetToCell(wrapped.lineLengths, wrapped.startRow, match.startIndex);
      const end = offsetToCell(
        wrapped.lineLengths,
        wrapped.startRow,
        match.startIndex + match.text.length - 1,
      );
      return {
        range: {
          start: { x: start.column, y: start.bufferLineNumber },
          end: { x: end.column, y: end.bufferLineNumber },
        },
        text: match.text,
        activate: activateDesktopTerminalLink,
        hover: () => this.onHover?.(match.entry),
        leave: () => this.onHover?.(null),
      };
    });

    callback(links.length > 0 ? links : undefined);
  }
}
