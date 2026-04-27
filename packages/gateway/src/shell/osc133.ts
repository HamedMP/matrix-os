export type Osc133Code = "A" | "B" | "C" | "D";

export type Osc133Mark =
  | { code: "A"; kind: "prompt-start" }
  | { code: "B"; kind: "command-start" }
  | { code: "C"; kind: "command-executed" }
  | { code: "D"; kind: "command-finished"; exitCode: number | null };

export interface Osc133ParserOptions {
  maxPendingBytes?: number;
}

export interface Osc133ParseResult {
  data: string;
  marks: Osc133Mark[];
}

const OSC_133_PATTERN = /\x1b\]133;([ABCD])(?:;([0-9]{1,3}))?(?:\x07|\x1b\\)/g;

export class Osc133Parser {
  private pending = "";
  private readonly maxPendingBytes: number;

  constructor(options: Osc133ParserOptions = {}) {
    this.maxPendingBytes = options.maxPendingBytes ?? 4096;
  }

  write(data: string): Osc133ParseResult {
    const combined = this.pending + data;
    const parseUntil = findSafeParseBoundary(combined);
    const complete = combined.slice(0, parseUntil);
    this.pending = combined.slice(parseUntil);

    if (Buffer.byteLength(this.pending) > this.maxPendingBytes) {
      this.pending = this.pending.slice(-this.maxPendingBytes);
    }

    const marks: Osc133Mark[] = [];
    OSC_133_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = OSC_133_PATTERN.exec(complete)) !== null) {
      const mark = markFromMatch(match[1] as Osc133Code, match[2]);
      if (mark) {
        marks.push(mark);
      }
    }

    return { data, marks };
  }

  get pendingBytes(): number {
    return Buffer.byteLength(this.pending);
  }
}

function findSafeParseBoundary(value: string): number {
  const lastEsc = value.lastIndexOf("\x1b]133;");
  if (lastEsc === -1) {
    return value.length;
  }
  const terminatorBel = value.indexOf("\x07", lastEsc);
  const terminatorSt = value.indexOf("\x1b\\", lastEsc);
  if (terminatorBel !== -1 || terminatorSt !== -1) {
    return value.length;
  }
  return lastEsc;
}

function markFromMatch(code: Osc133Code, rawExitCode?: string): Osc133Mark | null {
  switch (code) {
    case "A":
      return { code, kind: "prompt-start" };
    case "B":
      return { code, kind: "command-start" };
    case "C":
      return { code, kind: "command-executed" };
    case "D":
      return {
        code,
        kind: "command-finished",
        exitCode: rawExitCode ? Number.parseInt(rawExitCode, 10) : null,
      };
  }
}
