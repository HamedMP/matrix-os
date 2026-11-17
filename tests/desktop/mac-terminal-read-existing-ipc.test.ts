import { describe, expect, it } from "vitest";
import { MAC_TERMINAL_PROBE_INVOKE } from "../../desktop/src/shared/mac-terminal-probe-ipc";

const request = { chatId: "chat_selected", worktreeId: "wt_00000000000a" };
const reply = { status: "ready", terminalId: "t7", title: "Build tests", output: "one\ntwo" };

describe("existing Mac terminal read IPC", () => {
  const boundary = () => MAC_TERMINAL_PROBE_INVOKE["chat:mac-terminal-read-existing"];

  it("only accepts a Chat and worktree, with the live target chosen in native UI", () => {
    expect(boundary().request.parse(request)).toEqual(request);
    expect(boundary().request.safeParse({ ...request, terminalId: "t3" }).success).toBe(false);
  });

  it("returns bounded local screen text and refuses remote IDs or concealed controls", () => {
    expect(boundary().response.parse(reply)).toEqual(reply);
    expect(boundary().response.safeParse({ ...reply, terminalId: "elsewhere/t7" }).success).toBe(false);
    expect(boundary().response.safeParse({ ...reply, output: "\u001b[2Jtest" }).success).toBe(false);
    expect(boundary().response.safeParse({ ...reply, output: "a".repeat(2001) }).success).toBe(false);
    expect(boundary().response.safeParse({ ...reply, output: "𐐀".repeat(2000) }).success).toBe(true);
    expect(boundary().response.safeParse({ status: "declined", output: "unapproved" }).success).toBe(false);
  });
});
