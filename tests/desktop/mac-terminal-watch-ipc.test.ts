import { describe, expect, it } from "vitest";
import { MAC_TERMINAL_PROBE_INVOKE } from "../../desktop/src/shared/mac-terminal-probe-ipc";

const scope = { chatId: "chat_selected", worktreeId: "wt_00000000000a" };
const reference = { ...scope, watchId: "8aed9e59-aacc-492f-915a-0f0dc0ff47d0" };
const start = () => MAC_TERMINAL_PROBE_INVOKE["chat:mac-terminal-watch-start"];
const read = () => MAC_TERMINAL_PROBE_INVOKE["chat:mac-terminal-watch-read"];
const stop = () => MAC_TERMINAL_PROBE_INVOKE["chat:mac-terminal-watch-stop"];

describe("live Mac terminal watch IPC", () => {
  it("accepts only Chat and worktree on start, and binds read and stop to the issued handle", () => {
    expect(start().request.parse(scope)).toEqual(scope);
    expect(start().request.safeParse({ ...scope, terminalId: "t3" }).success).toBe(false);
    for (const boundary of [read(), stop()]) {
      expect(boundary.request.parse(reference)).toEqual(reference);
      expect(boundary.request.safeParse(scope).success).toBe(false);
      expect(boundary.request.safeParse({ ...reference, worktreeId: "../other" }).success).toBe(false);
      expect(boundary.request.safeParse({ ...reference, watchId: "t3" }).success).toBe(false);
    }
  });

  it("releases bounded display text only on successful reads", () => {
    expect(start().response.parse({
      status: "ready", watchId: reference.watchId, terminalId: "t7", title: "Build tests",
      output: "one\ntwo", expiresAt: 12345,
    })).toMatchObject({ output: "one\ntwo" });
    expect(read().response.parse({ status: "ready", output: "one\ntwo" })).toEqual({
      status: "ready", output: "one\ntwo",
    });
    expect(read().response.safeParse({ status: "ready", output: "\u001b[2Jtest" }).success).toBe(false);
    expect(read().response.safeParse({ status: "ready", output: "a".repeat(2001) }).success).toBe(false);
    expect(read().response.safeParse({ status: "ready", output: "𐐀".repeat(2000) }).success).toBe(true);
    expect(read().response.parse({ status: "ready", output: "" })).toEqual({ status: "ready", output: "" });
    expect(read().response.safeParse({ status: "ended", output: "old screen" }).success).toBe(false);
  });
});
