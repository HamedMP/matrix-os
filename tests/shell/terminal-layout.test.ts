import { describe, expect, it } from "vitest";
import type { PaneNode } from "@/stores/terminal-store";
import {
  DEFAULT_CWD,
  applyCompatModeToTabs,
  closePaneInTree,
  formatCwd,
  getCanonicalShellSessionIds,
  getFirstPaneId,
  getPaneIdsForSession,
  getPaneSessionId,
  getSessionIds,
  layoutUsesOnlyCanonicalShellSessions,
  removeSessionFromPaneTree,
  renameSessionInTree,
  setPaneSessionId,
  splitPaneInTree,
  type TerminalLayout,
} from "@/components/terminal/terminal-layout";

const splitTree: PaneNode = {
  type: "split",
  direction: "horizontal",
  ratio: 0.5,
  children: [
    { type: "pane", id: "left", cwd: "projects/app", sessionId: "shell-main" },
    { type: "pane", id: "right", cwd: DEFAULT_CWD, sessionId: "codex-build" },
  ],
};

describe("terminal layout helpers", () => {
  it("splits, closes, and finds panes without mutating the original tree", () => {
    const split = splitPaneInTree(splitTree, "left", "vertical");

    expect(split).not.toBe(splitTree);
    expect(splitTree.children[0]).toEqual({
      type: "pane",
      id: "left",
      cwd: "projects/app",
      sessionId: "shell-main",
    });
    expect(getFirstPaneId(split)).toBe("left");
    expect(getPaneSessionId(split, "left")).toBe("shell-main");

    const leftBranch = split.type === "split" ? split.children[0] : null;
    expect(leftBranch?.type).toBe("split");
    if (leftBranch?.type !== "split") {
      throw new Error("expected left branch to be split");
    }
    const newPane = leftBranch.children[1];
    expect(newPane.type).toBe("pane");
    expect(newPane.id).not.toBe("left");
    expect(newPane.cwd).toBe("projects/app");

    const closed = closePaneInTree(split, "right");
    expect(closed).not.toBeNull();
    expect(getSessionIds(closed!)).toEqual(["shell-main"]);

    const nestedClosed = closePaneInTree(split, newPane.id);
    expect(nestedClosed).not.toBeNull();
    const nestedLeft = nestedClosed?.type === "split" ? nestedClosed.children[0] : null;
    expect(nestedLeft).toEqual({
      type: "pane",
      id: "left",
      cwd: "projects/app",
      sessionId: "shell-main",
    });

    expect(closePaneInTree(splitTree, "missing-pane")).toBe(splitTree);
  });

  it("renames and removes shell sessions across pane trees", () => {
    const renamed = renameSessionInTree(splitTree, "codex-build", "codex-run");
    expect(getPaneSessionId(renamed, "right")).toBe("codex-run");
    expect(getPaneIdsForSession(renamed, "codex-run")).toEqual(["right"]);

    const reassigned = setPaneSessionId(renamed, "left", "codex-left");
    expect(getPaneSessionId(reassigned, "left")).toBe("codex-left");
    expect(
      reassigned.type === "split" && reassigned.children[0].type === "pane"
        ? reassigned.children[0].compatMode
        : null,
    ).toBe("codex-tui");

    const removed = removeSessionFromPaneTree(reassigned, "codex-left");
    expect(removed).toEqual({
      type: "pane",
      id: "right",
      cwd: DEFAULT_CWD,
      sessionId: "codex-run",
      compatMode: "codex-tui",
    });
  });

  it("detects canonical shell-session layouts and formats cwd labels", () => {
    const layout: TerminalLayout = {
      tabs: [
        { id: "one", label: "Main", paneTree: splitTree },
        { id: "two", label: "PTY", paneTree: { type: "pane", id: "pty", cwd: DEFAULT_CWD, sessionId: "pty_session" } },
      ],
    };

    expect(layoutUsesOnlyCanonicalShellSessions(layout)).toBe(false);
    expect(getCanonicalShellSessionIds(layout)).toEqual(["shell-main", "codex-build"]);
    expect(formatCwd(DEFAULT_CWD)).toBe("~/projects");
    expect(formatCwd("projects/matrix-os")).toBe("~/projects/matrix-os");
    expect(formatCwd("/tmp")).toBe("/tmp");

    expect(applyCompatModeToTabs(layout.tabs ?? [])[0]?.paneTree).toEqual({
      ...splitTree,
      children: [
        { type: "pane", id: "left", cwd: "projects/app", sessionId: "shell-main", compatMode: undefined },
        { type: "pane", id: "right", cwd: DEFAULT_CWD, sessionId: "codex-build", compatMode: "codex-tui" },
      ],
    });
  });
});
