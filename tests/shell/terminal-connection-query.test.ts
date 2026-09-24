import { describe, expect, it } from "vitest";
import { buildTerminalConnectionQuery } from "../../shell/src/components/terminal/terminal-connection-query.js";

const terminalRef = {
  workspaceId: "tws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  tabId: "tt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};

describe("Terminal connection query", () => {
  it("requests binary input and native scroll without changing an older client's optional fields", () => {
    expect(buildTerminalConnectionQuery({ terminalRef, fromSeq: 42, mobile: false })).toEqual({
      workspaceId: terminalRef.workspaceId,
      tabId: terminalRef.tabId,
      fromSeq: "42",
      client: "browser",
      inputCapability: "binary-input-v1",
      scrollCapability: "native-scroll-v1",
    });
  });

  it("includes mobile ownership and measured size when provided", () => {
    expect(buildTerminalConnectionQuery({
      terminalRef, fromSeq: 0, mobile: true, lease: "observe", size: { cols: 120, rows: 36 },
    })).toMatchObject({
      client: "mobile", lease: "observe", cols: "120", rows: "36",
    });
  });
});
