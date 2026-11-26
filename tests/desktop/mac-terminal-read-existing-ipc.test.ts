import { describe, expect, it } from "vitest";
import { MAC_TERMINAL_PROBE_INVOKE } from "../../desktop/src/shared/mac-terminal-probe-ipc";

const scope = { chatId: "chat_selected", worktreeId: "wt_00000000000a" };
const request = { ...scope, requestId: "ab9ca7ed-f4dc-4bc0-82a0-0d45fdd07c87" };
const reply = { status: "ready", terminalId: "t7", title: "Build tests", output: "one\ntwo" };

describe("existing Mac terminal read IPC", () => {
  const boundary = () => MAC_TERMINAL_PROBE_INVOKE["chat:mac-terminal-read-existing"];

  it("requires the same bounded request reference for start and cancel while keeping terminal choice native", () => {
    const cancel = MAC_TERMINAL_PROBE_INVOKE["chat:mac-terminal-read-existing-cancel"];
    for (const contract of [boundary(), cancel]) {
      expect(contract.request.parse(request)).toEqual(request);
      expect(contract.request.safeParse(scope).success).toBe(false);
      expect(contract.request.safeParse({ ...request, requestId: "x".repeat(200) }).success).toBe(false);
      expect(contract.request.safeParse({ ...request, terminalId: "t3" }).success).toBe(false);
    }
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
