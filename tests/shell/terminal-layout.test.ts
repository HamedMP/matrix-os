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
  mergeTerminalLayouts,
  removeSessionFromPaneTree,
  renameSessionInTree,
  setPaneSessionId,
  splitPaneInTree,
  type TerminalLayout,
} from "@/components/terminal/terminal-layout";

const MAIN_REF = "tws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:tt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CODEX_REF = "tws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:tt_cccccccccccccccccccccccccccccccc";

const splitTree: PaneNode = {
  type: "split",
  direction: "horizontal",
  ratio: 0.5,
  children: [
    { type: "pane", id: "left", cwd: "projects/app", sessionId: MAIN_REF },
    { type: "pane", id: "right", cwd: DEFAULT_CWD, sessionId: CODEX_REF },
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
      sessionId: MAIN_REF,
    });
    expect(getFirstPaneId(split)).toBe("left");
    expect(getPaneSessionId(split, "left")).toBe(MAIN_REF);

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
    expect(getSessionIds(closed!)).toEqual([MAIN_REF]);

    const nestedClosed = closePaneInTree(split, newPane.id);
    expect(nestedClosed).not.toBeNull();
    const nestedLeft = nestedClosed?.type === "split" ? nestedClosed.children[0] : null;
    expect(nestedLeft).toEqual({
      type: "pane",
      id: "left",
      cwd: "projects/app",
      sessionId: MAIN_REF,
    });

    expect(closePaneInTree(splitTree, "missing-pane")).toBe(splitTree);
  });

  it("renames and removes shell sessions across pane trees", () => {
    const renamed = renameSessionInTree(splitTree, CODEX_REF, "codex-run");
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
    expect(getCanonicalShellSessionIds(layout)).toEqual([MAIN_REF, CODEX_REF]);
    expect(formatCwd(DEFAULT_CWD)).toBe("~/projects");
    expect(formatCwd("projects/matrix-os")).toBe("~/projects/matrix-os");
    expect(formatCwd("/tmp")).toBe("/tmp");

    expect(applyCompatModeToTabs(layout.tabs ?? [])[0]?.paneTree).toEqual({
      ...splitTree,
      children: [
        { type: "pane", id: "left", cwd: "projects/app", sessionId: MAIN_REF, compatMode: undefined },
        { type: "pane", id: "right", cwd: DEFAULT_CWD, sessionId: CODEX_REF, compatMode: undefined },
      ],
    });
  });

  it("rebases independent local and remote layout edits without resurrecting deletions", () => {
    const base: TerminalLayout = {
      activeTabId: "main-tab",
      sidebarOpen: true,
      tabs: [{
        id: "main-tab",
        label: "Main",
        paneTree: { type: "pane", id: "main-pane", cwd: "projects", sessionId: "main" },
      }, {
        id: "deleted-tab",
        label: "Deleted",
        paneTree: { type: "pane", id: "deleted-pane", cwd: "projects", sessionId: "deleted" },
      }],
    };
    const local: TerminalLayout = {
      ...base,
      tabs: [{
        id: "main-tab",
        label: "Main",
        paneTree: { type: "pane", id: "main-pane", cwd: "projects", sessionId: "main-local" },
      }, base.tabs![1]!],
    };
    const remote: TerminalLayout = {
      activeTabId: "main-tab",
      sidebarOpen: false,
      tabs: [{
        id: "main-tab",
        label: "Main",
        paneTree: { type: "pane", id: "main-pane", cwd: "projects", sessionId: "main" },
      }, {
        id: "remote-tab",
        label: "Remote",
        paneTree: { type: "pane", id: "remote-pane", cwd: "projects", sessionId: "remote" },
      }],
    };

    expect(mergeTerminalLayouts(base, local, remote)).toEqual({
      activeTabId: "main-tab",
      sidebarOpen: false,
      tabs: [{
        id: "main-tab",
        label: "Main",
        paneTree: { type: "pane", id: "main-pane", cwd: "projects", sessionId: "main-local" },
      }, {
        id: "remote-tab",
        label: "Remote",
        paneTree: { type: "pane", id: "remote-pane", cwd: "projects", sessionId: "remote" },
      }],
    });
  });

  it("preserves an edit to a surviving pane when another window closes its sibling", () => {
    const base: TerminalLayout = {
      activeTabId: "main-tab",
      tabs: [{ id: "main-tab", label: "Main", paneTree: splitTree }],
    };
    const local: TerminalLayout = {
      ...base,
      tabs: [{
        id: "main-tab",
        label: "Main",
        paneTree: setPaneSessionId(splitTree, "left", "shell-local"),
      }],
    };
    const remote: TerminalLayout = {
      ...base,
      tabs: [{
        id: "main-tab",
        label: "Main",
        paneTree: splitTree.children[0],
      }],
    };

    expect(mergeTerminalLayouts(base, local, remote).tabs?.[0]?.paneTree).toMatchObject({
      type: "pane",
      id: "left",
      sessionId: "shell-local",
    });
  });
});
