import { describe, expect, it } from "vitest";
import { taskSessionTarget } from "../../packages/ui/src/project-board/session-ref";

describe("taskSessionTarget", () => {
  it("reads chat and terminal refs", () => {
    expect(taskSessionTarget("chat_abc123")).toEqual({ kind: "chat", chatId: "chat_abc123" });
    expect(taskSessionTarget("term.main.tab_7")).toEqual({ kind: "terminal", workspaceId: "main", tabId: "tab_7" });
  });

  it("rejects anything else", () => {
    for (const ref of ["", "chat_", "term.main", "term.a.b.c", "../chat_x", "session_1"]) expect(taskSessionTarget(ref)).toBeNull();
  });
});
