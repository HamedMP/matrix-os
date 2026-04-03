import type { Terminal } from "@xterm/xterm";

const MAX_URL_LENGTH = 2048;
const URL_REGEX = /https?:\/\/[^\s<>"')\]]{1,2048}/g;

const FILE_EXTENSIONS = /\.(ts|js|tsx|jsx|py|rs|go|md|json|yaml|yml|toml|css|html|sh|sql|rb|java|kt|swift|c|cpp|h)$/;
const FILE_PATH_REGEX = /(?:\.{1,2}\/|\/)[^\s:]+(?::\d+(?::\d+)?)?/g;

interface LinkMatch {
  text: string;
  startIndex: number;
}

export function detectUrls(text: string): LinkMatch[] {
  const matches: LinkMatch[] = [];
  let match: RegExpExecArray | null;
  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    const nextChar = text[match.index + match[0].length];
    if (match[0].length >= MAX_URL_LENGTH && nextChar && !/[\s<>"')\]]/.test(nextChar)) {
      continue;
    }
    let url = match[0];
    url = url.replace(/[.,;:!?)]+$/, "");
    matches.push({ text: url, startIndex: match.index });
  }
  return matches;
}

export function detectFilePaths(text: string): LinkMatch[] {
  const matches: LinkMatch[] = [];
  let match: RegExpExecArray | null;
  FILE_PATH_REGEX.lastIndex = 0;
  while ((match = FILE_PATH_REGEX.exec(text)) !== null) {
    const raw = match[0];
    const basePath = raw.replace(/:\d+(?::\d+)?$/, "");
    if (FILE_EXTENSIONS.test(basePath)) {
      matches.push({ text: raw, startIndex: match.index });
    }
  }
  return matches;
}

interface WrappedLineInfo {
  text: string;
  startRow: number;
  lineLengths: number[];
}

function getWrappedLine(terminal: Terminal, bufferRow: number): WrappedLineInfo | null {
  const buffer = terminal.buffer.active;
  const line = buffer.getLine(bufferRow);
  if (!line) return null;

  // Walk backward to find the start of this wrapped group
  let startRow = bufferRow;
  while (startRow > 0) {
    const prev = buffer.getLine(startRow);
    if (!prev || !(prev as unknown as { isWrapped: boolean }).isWrapped) break;
    startRow--;
  }

  // Walk forward to collect all wrapped continuations
  const parts: string[] = [];
  const lineLengths: number[] = [];
  let row = startRow;
  while (row < buffer.length) {
    const l = buffer.getLine(row);
    if (!l) break;
    if (row > startRow && !(l as unknown as { isWrapped: boolean }).isWrapped) break;
    const t = l.translateToString();
    parts.push(t);
    lineLengths.push(t.length);
    row++;
  }

  return { text: parts.join(""), startRow, lineLengths };
}

function offsetToRowCol(lineLengths: number[], startRow: number, offset: number): { x: number; y: number } {
  let remaining = offset;
  for (let i = 0; i < lineLengths.length; i++) {
    if (remaining < lineLengths[i]) {
      return { x: remaining + 1, y: startRow + i + 1 };
    }
    remaining -= lineLengths[i];
  }
  const lastIdx = lineLengths.length - 1;
  return { x: lineLengths[lastIdx], y: startRow + lastIdx + 1 };
}

type LinkEntry = {
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  text: string;
  activate: () => void;
};

export class WebLinkProvider {
  private readonly terminal: Terminal;

  constructor(terminal: Terminal) {
    this.terminal = terminal;
  }

  provideLinks(
    bufferLineNumber: number,
    callback: (links: LinkEntry[] | undefined) => void,
  ): void {
    const links: LinkEntry[] = [];

    // Get the full wrapped line group for URL detection
    const wrapped = getWrappedLine(this.terminal, bufferLineNumber - 1);
    if (!wrapped) {
      callback(undefined);
      return;
    }

    // Only process URLs on the first row of a wrapped group to avoid duplicates
    if (wrapped.startRow === bufferLineNumber - 1) {
      const urls = detectUrls(wrapped.text);
      for (const url of urls) {
        const start = offsetToRowCol(wrapped.lineLengths, wrapped.startRow, url.startIndex);
        const end = offsetToRowCol(wrapped.lineLengths, wrapped.startRow, url.startIndex + url.text.length - 1);
        links.push({
          range: { start, end },
          text: url.text,
          activate: () => {
            try {
              const parsed = new URL(url.text);
              if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                return;
              }
              window.open(parsed.href, "_blank", "noopener,noreferrer");
            } catch {
              // Ignore malformed URLs from terminal output.
            }
          },
        });
      }
    }

    // Single-line file paths (no wrapping needed)
    const line = this.terminal.buffer.active.getLine(bufferLineNumber - 1);
    if (line) {
      const text = line.translateToString();
      const filePaths = detectFilePaths(text);
      for (const fp of filePaths) {
        links.push({
          range: {
            start: { x: fp.startIndex + 1, y: bufferLineNumber },
            end: { x: fp.startIndex + fp.text.length + 1, y: bufferLineNumber },
          },
          text: fp.text,
          activate: () => {
            navigator.clipboard.writeText(fp.text).catch((err: unknown) => {
              console.warn("Failed to copy file path:", err instanceof Error ? err.message : err);
            });
          },
        });
      }
    }

    callback(links.length > 0 ? links : undefined);
  }
}
