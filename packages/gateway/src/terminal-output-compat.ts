const CSI_FINAL_BYTE = /[\x40-\x7e]/;
const MAX_PENDING_ESCAPE_BYTES = 1_000_000;
const MAX_DETECTION_TEXT_BYTES = 4096;
const CODEX_TUI_FOREGROUND = "#D6D8DD";
const CODEX_TUI_REVERSE_BG = "#30363D";
const CODEX_TUI_BANNER = "OpenAI Codex (";

export interface TerminalOutputCompatStream {
  readonly codexTuiActive: boolean;
  write(data: string): string;
  flush(): string;
}

interface CodexTuiCompatTheme {
  foreground: string;
  reverseBackground: string;
}

interface CodexTuiCompatTransform {
  observe(data: string): void;
  write(data: string): string;
  flush(): string;
}

type SgrColor = string[] | null;

interface SgrColorState {
  foreground: SgrColor;
  background: SgrColor;
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

function cloneColorState(state: SgrColorState): SgrColorState {
  return {
    foreground: state.foreground ? [...state.foreground] : null,
    background: state.background ? [...state.background] : null,
  };
}

function restoreColorParams(state: SgrColorState): string[] {
  return [
    ...(state.foreground ?? ["39"]),
    ...(state.background ?? ["49"]),
  ];
}

function applyColorParamToState(param: string, state: SgrColorState): void {
  if (param.startsWith("38:")) {
    state.foreground = [param];
    return;
  }
  if (param.startsWith("48:")) {
    state.background = [param];
    return;
  }

  const value = Number.parseInt(param, 10);
  if ((value >= 30 && value <= 37) || (value >= 90 && value <= 97)) {
    state.foreground = [param];
    return;
  }
  if ((value >= 40 && value <= 47) || (value >= 100 && value <= 107)) {
    state.background = [param];
    return;
  }
  if (param === "39") {
    state.foreground = null;
    return;
  }
  if (param === "49") {
    state.background = null;
  }
}

function applyColorGroupToState(group: string[], state: SgrColorState): void {
  const target = group[0];
  if (target === "38") {
    state.foreground = [...group];
  } else if (target === "48") {
    state.background = [...group];
  }
}

function observeSgr(sequence: string, colorState: SgrColorState): void {
  const body = sequence.slice(2, -1);
  const params = body.length === 0 ? ["0"] : body.split(";");

  for (let index = 0; index < params.length; index += 1) {
    const colorGroupLength = sgrColorGroupLength(params, index);
    if (colorGroupLength > 0) {
      applyColorGroupToState(params.slice(index, index + colorGroupLength), colorState);
      index += colorGroupLength - 1;
      continue;
    }

    const param = params[index] ?? "";
    if (param === "0" || param === "") {
      colorState.foreground = null;
      colorState.background = null;
      continue;
    }
    applyColorParamToState(param, colorState);
  }
}

function rewriteSgr(
  sequence: string,
  theme: CodexTuiCompatTheme,
  colorState: SgrColorState,
  reverseSnapshot: { current: SgrColorState | null },
): string {
  const body = sequence.slice(2, -1);
  const params = body.length === 0 ? ["0"] : body.split(";");
  const foreground = parseHexColor(theme.foreground, CODEX_TUI_FOREGROUND);
  const reverseBackground = parseHexColor(theme.reverseBackground, CODEX_TUI_REVERSE_BG);
  const foregroundParams = rgbSgr(38, foreground).split(";");
  const backgroundParams = rgbSgr(48, reverseBackground).split(";");
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
      const group = params.slice(index, index + colorGroupLength);
      applyColorGroupToState(group, colorState);
      if (reverseSnapshot.current) {
        applyColorGroupToState(group, reverseSnapshot.current);
      }
      pending.push(...group);
      index += colorGroupLength - 1;
      continue;
    }

    const param = params[index] ?? "";
    if (param === "0" || param === "") {
      flushPending();
      output.push("\x1b[0m");
      colorState.foreground = null;
      colorState.background = null;
      reverseSnapshot.current = null;
      continue;
    }
    if (param === "7") {
      flushPending();
      reverseSnapshot.current ??= cloneColorState(colorState);
      colorState.foreground = foregroundParams;
      colorState.background = backgroundParams;
      output.push(`\x1b[${rgbSgr(38, foreground)};${rgbSgr(48, reverseBackground)}m`);
      continue;
    }
    if (param === "27") {
      flushPending();
      if (reverseSnapshot.current) {
        colorState.foreground = reverseSnapshot.current.foreground;
        colorState.background = reverseSnapshot.current.background;
        output.push(`\x1b[${restoreColorParams(colorState).join(";")}m`);
        reverseSnapshot.current = null;
      } else {
        output.push("\x1b[27m");
      }
      continue;
    }
    applyColorParamToState(param, colorState);
    if (reverseSnapshot.current) {
      applyColorParamToState(param, reverseSnapshot.current);
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
  let trackingPending = "";
  const colorState: SgrColorState = { foreground: null, background: null };
  const reverseSnapshot: { current: SgrColorState | null } = { current: null };

  return {
    observe(data: string): void {
      const input = trackingPending + data;
      trackingPending = "";
      let index = 0;

      while (index < input.length) {
        const escapeIndex = input.indexOf("\x1b", index);
        if (escapeIndex === -1) {
          break;
        }

        if (escapeIndex + 1 >= input.length) {
          trackingPending = input.slice(escapeIndex);
          break;
        }

        const next = input[escapeIndex + 1];
        if (next === "[") {
          let finalIndex = escapeIndex + 2;
          while (finalIndex < input.length && !CSI_FINAL_BYTE.test(input[finalIndex] ?? "")) {
            finalIndex += 1;
          }
          if (finalIndex >= input.length) {
            trackingPending = input.slice(escapeIndex);
            break;
          }
          if (input[finalIndex] === "m") {
            observeSgr(input.slice(escapeIndex, finalIndex + 1), colorState);
          }
          index = finalIndex + 1;
          continue;
        }

        if (next === "]") {
          const terminator = findOscTerminator(input, escapeIndex + 2);
          index = terminator ?? input.length;
          continue;
        }

        index = escapeIndex + 2;
      }

      if (trackingPending.length > MAX_PENDING_ESCAPE_BYTES) {
        trackingPending = "";
      }
    },
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
          output += input[finalIndex] === "m"
            ? rewriteSgr(sequence, theme, colorState, reverseSnapshot)
            : sequence;
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
    flush(): string {
      const output = pending;
      pending = "";
      trackingPending = "";
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
        if (!codexTuiActive) {
          codexTuiTransform.observe(data);
        }
      }
      return codexTuiActive ? codexTuiTransform.write(data) : data;
    },
    flush(): string {
      return codexTuiActive ? codexTuiTransform.flush() : "";
    },
  };
}
