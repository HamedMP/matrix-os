import { describe, expect, it } from "vitest";
import {
  createCodexTuiCompatTransform,
  transformTerminalOutputForCompat,
} from "../../shell/src/components/terminal/codex-tui-compat.js";

const theme = {
  foreground: "#D6D8DD",
};
const MATRIX_PROMPT = "\x1b[0;1;36mpr-1031\x1b[0m:\x1b[0;1;34m~/projects\x1b[0m$ ";
const NORMALIZED_MATRIX_PROMPT = "\x1b[0m\x1b[1;36mpr-1031\x1b[0m:\x1b[0m\x1b[1;34m~/projects\x1b[0m$ ";

describe("Codex TUI ANSI compatibility transform", () => {
  it("rewrites reverse-video rows to explicit dark xterm colors", () => {
    const transform = createCodexTuiCompatTransform(theme);

    expect(transform.write("before \x1b[7mactive\x1b[27m after")).toBe(
      "before \x1b[38;2;214;216;221;48;2;48;54;61mactive\x1b[39;49m after",
    );
  });

  it("keeps reset as a full SGR reset", () => {
    const transform = createCodexTuiCompatTransform(theme);

    expect(transform.write("\x1b[7mactive\x1b[0mplain")).toBe(
      "\x1b[38;2;214;216;221;48;2;48;54;61mactive\x1b[0mplain",
    );
  });

  it("handles chunked SGR escape sequences across websocket frames", () => {
    const transform = createCodexTuiCompatTransform(theme);

    expect(transform.write("a\x1b[")).toBe("a");
    expect(transform.write("7")).toBe("");
    expect(transform.write("mrow\x1b[2")).toBe("\x1b[38;2;214;216;221;48;2;48;54;61mrow");
    expect(transform.write("7m")).toBe("\x1b[39;49m");
  });

  it("preserves OSC 52 and non-SGR escape sequences", () => {
    const transform = createCodexTuiCompatTransform(theme);
    const osc52 = "\x1b]52;c;SGVsbG8=\x07";
    const cursorMove = "\x1b[2J\x1b[3;4H";

    expect(transform.write(`${osc52}${cursorMove}`)).toBe(`${osc52}${cursorMove}`);
  });

  it("preserves truecolor and indexed colors that contain zero components", () => {
    const transform = createCodexTuiCompatTransform(theme);

    expect(transform.write("\x1b[38;2;255;0;0mred\x1b[48;2;0;16;32mbg\x1b[38;5;0mblack")).toBe(
      "\x1b[38;2;255;0;0mred\x1b[48;2;0;16;32mbg\x1b[38;5;0mblack",
    );
  });

  it("handles reverse-video controls after truecolor parameters", () => {
    const transform = createCodexTuiCompatTransform(theme);

    expect(transform.write("\x1b[38;2;255;0;0;7mactive\x1b[27;48;2;0;16;32mplain")).toBe(
      "\x1b[38;2;255;0;0m\x1b[38;2;214;216;221;48;2;48;54;61mactive\x1b[39;49m\x1b[48;2;0;16;32mplain",
    );
  });

  it("leaves non-Codex terminal output byte-for-byte unchanged", () => {
    const output = "plain\x1b[7mreverse\x1b[27m\x1b]52;c;SGVsbG8=\x07";
    const transform = createCodexTuiCompatTransform(theme);

    expect(transformTerminalOutputForCompat(output, undefined, transform)).toBe(output);
  });

  it("preserves a reset-baselined Matrix prompt when its cyan SGR is split", () => {
    const transform = createCodexTuiCompatTransform(theme);

    expect(transform.write("\x1b[?1049h\x1b[2mCodex\x1b[?1049l\x1b[0;1;")).toBe(
      "\x1b[?1049h\x1b[2mCodex\x1b[?1049l",
    );
    expect(transform.write(MATRIX_PROMPT.slice("\x1b[0;1;".length))).toBe(NORMALIZED_MATRIX_PROMPT);
  });
});
