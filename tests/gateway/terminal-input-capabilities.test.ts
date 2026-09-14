import { describe, expect, it } from "vitest";

import {
  parseTerminalInputCapabilityRequest,
  terminalFrameForInputCapabilities,
} from "../../packages/gateway/src/terminal-input-capabilities.js";

const ATTACHED_FRAME = {
  type: "attached" as const,
  terminalRef: {
    workspaceId: "tws_00000000000000000000000000000001",
    tabId: "tt_00000000000000000000000000000001",
  },
  revision: 1,
  canonicalSize: { cols: 80, rows: 24 },
  nextSeq: 0,
  capabilities: ["binary-input-v1" as const],
};

describe("terminal input capability negotiation", () => {
  it("accepts only the exact bounded binary-input capability request", () => {
    expect(parseTerminalInputCapabilityRequest("binary-input-v1")).toBe(true);
    expect(parseTerminalInputCapabilityRequest(undefined)).toBe(false);
    expect(parseTerminalInputCapabilityRequest("binary-input-v2")).toBe(false);
    expect(parseTerminalInputCapabilityRequest("binary-input-v1,other")).toBe(false);
  });

  it("does not send new attached fields to older clients that did not opt in", () => {
    expect(terminalFrameForInputCapabilities(ATTACHED_FRAME, false)).toEqual({
      type: "attached",
      terminalRef: ATTACHED_FRAME.terminalRef,
      revision: 1,
      canonicalSize: { cols: 80, rows: 24 },
      nextSeq: 0,
    });
  });

  it("advertises binary input only to clients that explicitly opted in", () => {
    expect(terminalFrameForInputCapabilities(ATTACHED_FRAME, true)).toEqual(ATTACHED_FRAME);
    const output = {
      type: "output" as const,
      terminalRef: ATTACHED_FRAME.terminalRef,
      revision: 1,
      seq: 0,
      data: "ready",
    };
    expect(terminalFrameForInputCapabilities(output, false)).toBe(output);
  });
});
