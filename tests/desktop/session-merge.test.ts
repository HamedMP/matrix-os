import { describe, expect, it } from "vitest";
import { mergeAttachableSessions } from "@desktop/renderer/src/lib/session-merge";

const WORKSPACE_ID = `tws_${"a".repeat(32)}`;
const TAB_ID = `tt_${"b".repeat(32)}`;
const REF = `${WORKSPACE_ID}:${TAB_ID}`;

describe("mergeAttachableSessions", () => {
  it("returns no attach targets without workspace tabs or bound agent runtimes", () => {
    expect(mergeAttachableSessions([], [])).toEqual({ sessions: [], aliasMap: {} });
  });

  it("uses stable TerminalRef keys while preserving display metadata", () => {
    const result = mergeAttachableSessions([{
      id: WORKSPACE_ID,
      projectId: "project_matrix",
      tabs: [{ id: TAB_ID, name: "build", cwd: "projects/matrix-os", status: "running", agent: { providerId: "codex" } }],
    }], []);

    expect(result.sessions).toEqual([{
      name: "build",
      attachName: REF,
      status: "active",
      source: "terminal-tab",
      projectId: "project_matrix",
      cwd: "projects/matrix-os",
      agent: "codex",
    }]);
    expect(result.aliasMap).toEqual({ [REF]: REF });
  });

  it("keeps duplicate display names as distinct tab identities", () => {
    const secondTab = `tt_${"c".repeat(32)}`;
    const result = mergeAttachableSessions([{
      id: WORKSPACE_ID,
      tabs: [{ id: TAB_ID, name: "shell" }, { id: secondTab, name: "shell" }],
    }], []);

    expect(result.sessions.map((session) => session.attachName)).toEqual([REF, `${WORKSPACE_ID}:${secondTab}`]);
  });

  it("maps exited, failed, and unavailable tabs to exited", () => {
    const statuses = ["exited", "failed", "unavailable"];
    const tabs = statuses.map((status, index) => ({
      id: `tt_${String(index + 1).repeat(32)}`,
      name: status,
      status,
    }));
    expect(mergeAttachableSessions([{ id: WORKSPACE_ID, tabs }], []).sessions.map((session) => session.status))
      .toEqual(["exited", "exited", "exited"]);
  });

  it("enriches an existing tab from a coding workspace without changing its identity", () => {
    const result = mergeAttachableSessions(
      [{ id: WORKSPACE_ID, tabs: [{ id: TAB_ID, name: "agent", status: "running" }] }],
      [{
        id: "sess_agent",
        sessionId: "alias_agent",
        kind: "agent",
        agent: "codex",
        projectSlug: "matrix-os",
        taskId: "task_1",
        runtime: { terminalRef: { workspaceId: WORKSPACE_ID, tabId: TAB_ID }, status: "running" },
      }],
    );

    expect(result.sessions).toEqual([expect.objectContaining({
      attachName: REF,
      source: "terminal-tab",
      kind: "agent",
      agent: "codex",
      projectSlug: "matrix-os",
      taskId: "task_1",
    })]);
    expect(result.aliasMap).toMatchObject({ sess_agent: REF, alias_agent: REF, [REF]: REF });
  });

  it("rejects malformed runtime references instead of exposing legacy session IDs", () => {
    const result = mergeAttachableSessions([], [{
      id: "legacy-id",
      runtime: { terminalRef: { workspaceId: "main", tabId: "shell" }, status: "running" },
    }]);
    expect(result).toEqual({ sessions: [], aliasMap: {} });
  });
});
