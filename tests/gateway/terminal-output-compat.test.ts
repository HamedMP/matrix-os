import { describe, expect, it } from "vitest";
import { createTerminalOutputCompatStream } from "../../packages/gateway/src/terminal-output-compat.js";

const READABLE_PROMPT = "\x1b[38;2;214;216;221;48;2;48;54;61mprompt\x1b[39;49m";
const RAW_PROMPT = "\x1b[7mprompt\x1b[27m";
const RAW_EXPLICIT_PROMPT_BG = "\x1b[39m\x1b[48;2;240;240;239mprompt\x1b[39;49m";
const READABLE_EXPLICIT_PROMPT_BG = "\x1b[39m\x1b[38;2;214;216;221;48;2;48;54;61mprompt\x1b[38;2;214;216;221;49m";
const MATRIX_PROMPT = "\x1b[0;1;36mpr-1031\x1b[0m:\x1b[0;1;34m~/projects\x1b[0m$ ";
const NORMALIZED_MATRIX_PROMPT = "\x1b[0m\x1b[1;36mpr-1031\x1b[0m:\x1b[0m\x1b[1;34m~/projects\x1b[0m$ ";

describe("terminal output compatibility stream", () => {
  it("leaves ordinary reverse-video output unchanged before Codex detection", () => {
    const stream = createTerminalOutputCompatStream({ sessionName: "main" });

    expect(stream.write(`plain ${RAW_PROMPT}`)).toBe(`plain ${RAW_PROMPT}`);
  });

  it("rewrites Codex-named sessions immediately", () => {
    const stream = createTerminalOutputCompatStream({ sessionName: "codex-backend" });

    expect(stream.write(RAW_PROMPT)).toBe(READABLE_PROMPT);
  });

  it("rewrites Codex prompt rows with explicit light RGB backgrounds immediately", () => {
    const stream = createTerminalOutputCompatStream({ sessionName: "codex-backend" });

    expect(stream.write(RAW_EXPLICIT_PROMPT_BG)).toBe(READABLE_EXPLICIT_PROMPT_BG);
  });

  it("detects manual Codex launches from a later banner chunk", () => {
    const stream = createTerminalOutputCompatStream({ sessionName: "main" });

    expect(stream.write("plain shell output\n")).toBe("plain shell output\n");
    expect(stream.write("OpenAI Codex (v0.142.5)\n")).toBe("OpenAI Codex (v0.142.5)\n");
    expect(stream.write(RAW_PROMPT)).toBe(READABLE_PROMPT);
  });

  it("rewrites explicit light prompt backgrounds only after manual Codex detection", () => {
    const stream = createTerminalOutputCompatStream({ sessionName: "main" });

    expect(stream.write(RAW_EXPLICIT_PROMPT_BG)).toBe(RAW_EXPLICIT_PROMPT_BG);
    expect(stream.write("OpenAI Codex (v0.142.5)\n")).toBe("OpenAI Codex (v0.142.5)\n");
    expect(stream.write(RAW_EXPLICIT_PROMPT_BG)).toBe(READABLE_EXPLICIT_PROMPT_BG);
  });

  it("detects Codex and rewrites reverse video in the same chunk", () => {
    const stream = createTerminalOutputCompatStream({ sessionName: "main" });

    expect(stream.write(`OpenAI Codex (v0.142.5)\n${RAW_PROMPT}`)).toBe(
      `OpenAI Codex (v0.142.5)\n${READABLE_PROMPT}`,
    );
  });

  it("detects Codex and rewrites explicit light prompt backgrounds in the same chunk", () => {
    const stream = createTerminalOutputCompatStream({ sessionName: "main" });

    expect(stream.write(`OpenAI Codex (v0.142.5)\n${RAW_EXPLICIT_PROMPT_BG}`)).toBe(
      `OpenAI Codex (v0.142.5)\n${READABLE_EXPLICIT_PROMPT_BG}`,
    );
  });

  it("detects Codex banners split across chunks", () => {
    const stream = createTerminalOutputCompatStream({ sessionName: "main" });

    expect(stream.write("OpenAI ")).toBe("OpenAI ");
    expect(stream.write(`Codex (v0.142.5)\n${RAW_PROMPT}`)).toBe(
      `Codex (v0.142.5)\n${READABLE_PROMPT}`,
    );
  });

  it("handles chunked SGR escape sequences once Codex compatibility is active", () => {
    const stream = createTerminalOutputCompatStream({ sessionName: "codex-backend" });

    expect(stream.write("a\x1b[")).toBe("a");
    expect(stream.write("7")).toBe("");
    expect(stream.write("mprompt\x1b[2")).toBe("\x1b[38;2;214;216;221;48;2;48;54;61mprompt");
    expect(stream.write("7m")).toBe("\x1b[39;49m");
  });

  it("handles chunked explicit light RGB background SGR once Codex compatibility is active", () => {
    const stream = createTerminalOutputCompatStream({ sessionName: "codex-backend" });

    expect(stream.write("\x1b[48;2;240;")).toBe("");
    expect(stream.write("240;239mprompt\x1b[39m")).toBe(
      "\x1b[38;2;214;216;221;48;2;48;54;61mprompt\x1b[38;2;214;216;221m",
    );
  });

  it("keeps non-Codex explicit light RGB backgrounds unchanged", () => {
    const stream = createTerminalOutputCompatStream({ sessionName: "main" });

    expect(stream.write(RAW_EXPLICIT_PROMPT_BG)).toBe(RAW_EXPLICIT_PROMPT_BG);
  });

  it("preserves explicit non-default foregrounds set with prompt background", () => {
    const stream = createTerminalOutputCompatStream({ sessionName: "codex-backend" });

    expect(stream.write("\x1b[32;48;2;240;240;239mselected\x1b[39mstill band")).toBe(
      "\x1b[32;48;2;48;54;61mselected\x1b[38;2;214;216;221mstill band",
    );
  });

  it("restores the pre-reverse color state when reverse video turns off", () => {
    const stream = createTerminalOutputCompatStream({ sessionName: "codex-backend" });

    expect(stream.write("\x1b[32mgreen\x1b[7mselected\x1b[27mstill green")).toBe(
      "\x1b[32mgreen\x1b[38;2;214;216;221;48;2;48;54;61mselected\x1b[32;49mstill green",
    );
  });

  it("preserves colors set in the same SGR as reverse video", () => {
    const stream = createTerminalOutputCompatStream({ sessionName: "codex-backend" });

    expect(stream.write("\x1b[7;32mselected\x1b[27mstill green")).toBe(
      "\x1b[38;2;214;216;221;48;2;48;54;61m\x1b[32mselected\x1b[32;49mstill green",
    );
  });

  it("preserves colon-form extended colors set while reverse video is active", () => {
    const stream = createTerminalOutputCompatStream({ sessionName: "codex-backend" });

    expect(stream.write("\x1b[7;38:2::100:200:100mselected\x1b[27mstill colored")).toBe(
      "\x1b[38;2;214;216;221;48;2;48;54;61m\x1b[38:2::100:200:100mselected\x1b[38:2::100:200:100;49mstill colored",
    );
  });

  it("tracks color state before manual Codex detection activates", () => {
    const stream = createTerminalOutputCompatStream({ sessionName: "main" });

    expect(stream.write("\x1b[32mgreen shell output\n")).toBe("\x1b[32mgreen shell output\n");
    expect(stream.write("OpenAI Codex (v0.142.5)\n")).toBe("OpenAI Codex (v0.142.5)\n");
    expect(stream.write("\x1b[7mprompt\x1b[27mstill green")).toBe(
      "\x1b[38;2;214;216;221;48;2;48;54;61mprompt\x1b[32;49mstill green",
    );
  });

  it("flushes partial escape bytes so terminal replay is not truncated", () => {
    const stream = createTerminalOutputCompatStream({ sessionName: "codex-backend" });

    expect(stream.write("prompt\x1b[")).toBe("prompt");
    expect(stream.flush()).toBe("\x1b[");
    expect(stream.flush()).toBe("");
  });

  it("preserves OSC and non-SGR escape sequences", () => {
    const stream = createTerminalOutputCompatStream({ sessionName: "codex-backend" });
    const osc52 = "\x1b]52;c;SGVsbG8=\x07";
    const cursorMove = "\x1b[2J\x1b[3;4H";

    expect(stream.write(`${osc52}${cursorMove}`)).toBe(`${osc52}${cursorMove}`);
  });

  it("preserves a reset-baselined Matrix prompt after chunked Codex alternate-screen exit", () => {
    const stream = createTerminalOutputCompatStream({ sessionName: "main" });

    expect(stream.write("OpenAI Codex (v0.142.5)\n\x1b[?1049h\x1b[2mCodex")).toBe(
      "OpenAI Codex (v0.142.5)\n\x1b[?1049h\x1b[2mCodex",
    );
    expect(stream.write("\x1b[?104")).toBe("");
    expect(stream.write("9l\x1b[0;1;")).toBe("\x1b[?1049l");
    expect(stream.write(MATRIX_PROMPT.slice("\x1b[0;1;".length))).toBe(NORMALIZED_MATRIX_PROMPT);
  });
});
