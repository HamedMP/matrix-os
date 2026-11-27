import { describe, expect, it } from "vitest";
import {
  COLLABORATION_TERMINAL_INPUT_BYTE_LIMIT,
  CollaborationTeamTerminalActionSchema,
  CollaborationTeamTerminalInputRejectedFrameSchema,
  CollaborationTerminalActionSchema,
  isTeamTerminalInputAction,
} from "@matrix-os/contracts";

const base = {
  clientRequestId: "6f1c2c4e-0f7a-4c33-9a62-3f1d8a2b9c10",
  incarnation: "terminal-0123456789abcdef0123456789abcdef",
};

describe("team terminal contracts (spec 2710)", () => {
  it("accepts shared input without a lease and keeps every legacy action", () => {
    const input = CollaborationTeamTerminalActionSchema.parse({ ...base, type: "input_shared", connectionId: "connection_a", data: "ls\r" });
    expect(isTeamTerminalInputAction(input)).toBe(true);
    for (const legacy of [
      { ...base, type: "acquire", connectionId: "connection_a" },
      { ...base, type: "input", connectionId: "connection_a", leaseEpoch: "1", data: "x" },
      { ...base, type: "stop" },
    ]) {
      expect(CollaborationTeamTerminalActionSchema.parse(legacy)).toEqual(CollaborationTerminalActionSchema.parse(legacy));
    }
  });

  it("bounds shared input and paste by the existing terminal input limit", () => {
    const tooLarge = "x".repeat(COLLABORATION_TERMINAL_INPUT_BYTE_LIMIT + 1);
    expect(CollaborationTeamTerminalActionSchema.safeParse({ ...base, type: "paste_shared", connectionId: "connection_a", data: tooLarge }).success).toBe(false);
    expect(CollaborationTeamTerminalActionSchema.safeParse({ ...base, type: "input_shared", connectionId: "connection_a", data: "" }).success).toBe(false);
  });

  it("only accepts the two input modes and rejects unknown keys", () => {
    expect(CollaborationTeamTerminalActionSchema.parse({ ...base, type: "input_mode", mode: "owner" })).toMatchObject({ mode: "owner" });
    expect(CollaborationTeamTerminalActionSchema.safeParse({ ...base, type: "input_mode", mode: "everyone" }).success).toBe(false);
    expect(CollaborationTeamTerminalActionSchema.safeParse({ ...base, type: "input_mode", mode: "shared", extra: 1 }).success).toBe(false);
  });

  it("describes a rejected input with a bounded code and the request it answers", () => {
    const frame = CollaborationTeamTerminalInputRejectedFrameSchema.parse({
      version: 1, type: "terminal.input_rejected", scopeId: "6f1c2c4e-0f7a-4c33-9a62-3f1d8a2b9c11",
      incarnation: base.incarnation,
      clientRequestId: base.clientRequestId, code: "input_paused",
    });
    expect(frame.code).toBe("input_paused");
    expect(CollaborationTeamTerminalInputRejectedFrameSchema.safeParse({ ...frame, code: "provider_error" }).success).toBe(false);
  });
});
