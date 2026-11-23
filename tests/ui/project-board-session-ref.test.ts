import { describe, expect, it } from "vitest";
import { taskSessionTarget } from "../../packages/ui/src/project-board/session-ref";

describe("taskSessionTarget", () => {
  it("reads terminal refs", () => {
    expect(taskSessionTarget("term.main.tab_7")).toEqual({ kind: "terminal", workspaceId: "main", tabId: "tab_7" });
  });

  it("rejects chat refs, which are tasks rather than sessions, and anything else", () => {
    for (const ref of ["chat_abc123", "", "chat_", "term.main", "term.a.b.c", "../chat_x", "session_1"]) expect(taskSessionTarget(ref)).toBeNull();
  });
});
