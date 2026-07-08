const CSI_FINAL_BYTE = /[\x40-\x7e]/;
const MAX_PENDING_ESCAPE_BYTES = 1_000_000;
const MAX_DETECTION_TEXT_BYTES = 4096;
const CODEX_TUI_FOREGROUND = "#D6D8DD";
const CODEX_TUI_REVERSE_BG = "#30363D";
const CODEX_TUI_BANNER = "OpenAI Codex (";

export interface TerminalOutputCompatStream {
  readonly codexTuiActive: boolean;
  write(data: string): string;
}

interface CodexTuiCompatTheme {
  foreground: string;
  reverseBackground: string;
}

interface CodexTuiCompatTransform {
  write(data: string): string;
}

function parseHexColor(value: string, fallback: string): [number, number, number] {
  const hex = value.trim().match(/^#?([0-9a-fA-F]{6})/);
  const color = hex?.[1] ?? fallback.replace("#", "");
  return [
    parseInt(color.slice(0, 2), 16),
    parseInt(color.slice(2, 4), 16),
    parseInt(color.slice(4, 6), 16),
  ];
}

function rgbSgr(prefix: 38 | 48, color: [number, number, number]): string {
  return `${prefix};2;${color[0]};${color[1]};${color[2]}`;
}

function sgrColorGroupLength(params: string[], index: number): number {
  const colorTarget = params[index];
  if (colorTarget !== "38" && colorTarget !== "48") {
    return 0;
  }

  const colorMode = params[index + 1];
  if (colorMode === "2" && params.length >= index + 5) {
    return 5;
  }
  if (colorMode === "5" && params.length >= index + 3) {
    return 3;
  }
  return 0;
}

function rewriteSgr(sequence: string, theme: CodexTuiCompatTheme): string {
  const body = sequence.slice(2, -1);
  const params = body.length === 0 ? ["0"] : body.split(";");
  const foreground = parseHexColor(theme.foreground, CODEX_TUI_FOREGROUND);
  const reverseBackground = parseHexColor(theme.reverseBackground, CODEX_TUI_REVERSE_BG);
  const output: string[] = [];
  let pending: string[] = [];

  const flushPending = () => {
    if (pending.length === 0) return;
    output.push(`\x1b[${pending.join(";")}m`);
    pending = [];
  };

  for (let index = 0; index < params.length; index += 1) {
    const colorGroupLength = sgrColorGroupLength(params, index);
    if (colorGroupLength > 0) {
      pending.push(...params.slice(index, index + colorGroupLength));
      index += colorGroupLength - 1;
      continue;
    }

    const param = params[index] ?? "";
    if (param === "0" || param === "") {
      flushPending();
      output.push("\x1b[0m");
      continue;
    }
    if (param === "7") {
      flushPending();
      output.push(`\x1b[${rgbSgr(38, foreground)};${rgbSgr(48, reverseBackground)}m`);
      continue;
    }
    if (param === "27") {
      flushPending();
      output.push("\x1b[39;49m");
      continue;
    }
    pending.push(param);
  }

  flushPending();
  return output.join("");
}

function findOscTerminator(value: string, start: number): number | null {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x07) {
      return index + 1;
    }
    if (code === 0x1b && value[index + 1] === "\\") {
      return index + 2;
    }
  }
  return null;
}

function createCodexTuiCompatTransform(theme: CodexTuiCompatTheme): CodexTuiCompatTransform {
  let pending = "";

  return {
    write(data: string): string {
      const input = pending + data;
      pending = "";
      let output = "";
      let index = 0;

      while (index < input.length) {
        const escapeIndex = input.indexOf("\x1b", index);
        if (escapeIndex === -1) {
          output += input.slice(index);
          break;
        }

        output += input.slice(index, escapeIndex);
        if (escapeIndex + 1 >= input.length) {
          pending = input.slice(escapeIndex);
          break;
        }

        const next = input[escapeIndex + 1];
        if (next === "[") {
          let finalIndex = escapeIndex + 2;
          while (finalIndex < input.length && !CSI_FINAL_BYTE.test(input[finalIndex] ?? "")) {
            finalIndex += 1;
          }
          if (finalIndex >= input.length) {
            pending = input.slice(escapeIndex);
            break;
          }
          const sequence = input.slice(escapeIndex, finalIndex + 1);
          output += input[finalIndex] === "m" ? rewriteSgr(sequence, theme) : sequence;
          index = finalIndex + 1;
          continue;
        }

        if (next === "]") {
          const terminator = findOscTerminator(input, escapeIndex + 2);
          if (terminator === null) {
            pending = input.slice(escapeIndex);
            break;
          }
          output += input.slice(escapeIndex, terminator);
          index = terminator;
          continue;
        }

        output += input.slice(escapeIndex, escapeIndex + 2);
        index = escapeIndex + 2;
      }

      if (pending.length > MAX_PENDING_ESCAPE_BYTES) {
        output += pending;
        pending = "";
      }

      return output;
    },
  };
}

function stripAnsiForDetection(input: string): string {
  let output = "";
  let index = 0;

  while (index < input.length) {
    const escapeIndex = input.indexOf("\x1b", index);
    if (escapeIndex === -1) {
      output += input.slice(index);
      break;
    }

    output += input.slice(index, escapeIndex);
    if (escapeIndex + 1 >= input.length) {
      break;
    }

    const next = input[escapeIndex + 1];
    if (next === "[") {
      let finalIndex = escapeIndex + 2;
      while (finalIndex < input.length && !CSI_FINAL_BYTE.test(input[finalIndex] ?? "")) {
        finalIndex += 1;
      }
      index = finalIndex < input.length ? finalIndex + 1 : input.length;
      continue;
    }

    if (next === "]") {
      const terminator = findOscTerminator(input, escapeIndex + 2);
      index = terminator ?? input.length;
      continue;
    }

    index = escapeIndex + 2;
  }

  return output;
}

function trimDetectionText(value: string): string {
  const bytes = Buffer.byteLength(value);
  if (bytes <= MAX_DETECTION_TEXT_BYTES) {
    return value;
  }

  let output = "";
  let outputBytes = 0;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const char = value[index]!;
    const charBytes = Buffer.byteLength(char);
    if (outputBytes + charBytes > MAX_DETECTION_TEXT_BYTES) {
      break;
    }
    output = char + output;
    outputBytes += charBytes;
  }
  return output;
}

function isCodexTuiSessionName(sessionName: string | undefined): boolean {
  return sessionName?.startsWith("codex-") === true;
}

export function createTerminalOutputCompatStream(options: {
  sessionName?: string;
} = {}): TerminalOutputCompatStream {
  let codexTuiActive = isCodexTuiSessionName(options.sessionName);
  let detectionText = "";
  const codexTuiTransform = createCodexTuiCompatTransform({
    foreground: CODEX_TUI_FOREGROUND,
    reverseBackground: CODEX_TUI_REVERSE_BG,
  });

  return {
    get codexTuiActive() {
      return codexTuiActive;
    },
    write(data: string): string {
      if (!codexTuiActive) {
        detectionText = trimDetectionText(detectionText + stripAnsiForDetection(data));
        codexTuiActive = detectionText.includes(CODEX_TUI_BANNER);
      }
      return codexTuiActive ? codexTuiTransform.write(data) : data;
    },
  };
}
