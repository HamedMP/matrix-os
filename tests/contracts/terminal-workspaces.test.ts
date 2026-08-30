import { describe, expect, it } from "vitest";
import {
  AgentThreadEventSchema,
  CreateAgentThreadRequestSchema,
  TerminalTabClientFrameSchema,
  TerminalRefSchema,
  TerminalTabServerFrameSchema,
  TerminalTabSchema,
  TerminalWorkspaceSchema,
} from "../../packages/contracts/src/index.js";

const now = "2026-08-11T12:00:00.000Z";

describe("project-scoped terminal workspace contracts", () => {
  it("represents a stable tab reference independently from Zellij runtime ids", () => {
    const terminalRef = TerminalRefSchema.parse({
      workspaceId: "tws_0123456789abcdef0123456789abcdef",
      tabId: "tt_0123456789abcdef0123456789abcdef",
    });

    expect(terminalRef).toEqual({
      workspaceId: "tws_0123456789abcdef0123456789abcdef",
      tabId: "tt_0123456789abcdef0123456789abcdef",
    });
    expect(() => TerminalRefSchema.parse({ ...terminalRef, sessionId: "legacy" })).toThrow();
  });

  it("keeps internal Zellij identities out of public workspace and tab projections", () => {
    const workspace = TerminalWorkspaceSchema.parse({
      id: "tws_0123456789abcdef0123456789abcdef",
      scope: "main",
      canonicalSize: { cols: 120, rows: 36 },
      status: "running",
      revision: 3,
      createdAt: now,
      updatedAt: now,
      tabs: [{
        id: "tt_0123456789abcdef0123456789abcdef",
        workspaceId: "tws_0123456789abcdef0123456789abcdef",
        name: "main",
        cwd: "",
        status: "running",
        revision: 2,
        order: 0,
        createdAt: now,
        updatedAt: now,
      }],
    });

    expect(workspace.scope).toBe("main");
    expect(() => TerminalWorkspaceSchema.parse({ ...workspace, zellijSessionName: "matrix-private" })).toThrow();
    expect(() => TerminalTabSchema.parse({ ...workspace.tabs[0], zellijPaneId: 9 })).toThrow();
  });

  it("adds TerminalRef contracts while accepting legacy coding-agent ids during rollout", () => {
    const terminalRef = {
      workspaceId: "tws_0123456789abcdef0123456789abcdef",
      tabId: "tt_0123456789abcdef0123456789abcdef",
    };

    expect(CreateAgentThreadRequestSchema.parse({
      providerId: "codex",
      prompt: "Continue in the selected terminal tab.",
      terminalRef,
      clientRequestId: "req_terminal_ref",
    }).terminalRef).toEqual(terminalRef);
    expect(CreateAgentThreadRequestSchema.parse({
      providerId: "codex",
      prompt: "Accept an old client during rollout.",
      terminalSessionId: "legacy",
      clientRequestId: "req_legacy_terminal",
    }).terminalSessionId).toBe("legacy");

    expect(AgentThreadEventSchema.parse({
      type: "terminal.bound",
      eventId: "evt_terminal_ref",
      threadId: "thread_terminal_ref",
      occurredAt: now,
      terminalRef,
      terminalSessionId: `${terminalRef.workspaceId}:${terminalRef.tabId}`,
    }).terminalRef).toEqual(terminalRef);

    expect(TerminalTabClientFrameSchema.parse({
      type: "input",
      terminalRef,
      data: "ls\r",
    }).terminalRef).toEqual(terminalRef);
    expect(TerminalTabServerFrameSchema.parse({
      type: "snapshot",
      terminalRef,
      canonicalSize: { cols: 120, rows: 36 },
      revision: 4,
      seq: 12,
      ansi: "ready$ ",
      viewport: { top: 0, rows: 36 },
    }).revision).toBe(4);
    expect(TerminalTabServerFrameSchema.parse({
      type: "snapshot",
      terminalRef,
      canonicalSize: { cols: 120, rows: 36 },
      revision: 5,
      seq: 13,
      ansi: "x".repeat(5 * 1024 * 1024),
      viewport: { top: 0, rows: 36 },
    }).ansi).toHaveLength(5 * 1024 * 1024);
  });
});
