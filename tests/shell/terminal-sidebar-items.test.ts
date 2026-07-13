import { describe, expect, it } from "vitest";
import {
  filterTreeNodes,
  formatShellDisplayName,
  formatShellTabCount,
  getShellTabCount,
  updateNode,
  type TreeNode,
} from "../../shell/src/components/terminal/TerminalSidebarItems.js";
import type { ShellSessionSummary } from "../../shell/src/components/terminal/terminal-session-state.js";

const tree: TreeNode[] = [
  {
    name: "projects",
    type: "directory",
    gitStatus: null,
    path: "projects",
    expanded: false,
    children: [
      {
        name: "matrix-os",
        type: "directory",
        gitStatus: "modified",
        changedCount: 2,
        path: "projects/matrix-os",
        expanded: false,
        children: [
          {
            name: "TerminalApp.tsx",
            type: "file",
            gitStatus: "modified",
            path: "projects/matrix-os/TerminalApp.tsx",
          },
        ],
      },
      {
        name: "website",
        type: "directory",
        gitStatus: null,
        path: "projects/website",
      },
    ],
  },
];

describe("terminal sidebar items", () => {
  it("formats the canonical main shell name for display", () => {
    expect(formatShellDisplayName("main")).toBe("matrix-main");
    expect(formatShellDisplayName("project-shell")).toBe("project-shell");
  });

  it("counts shell tabs from explicit tab indexes when present", () => {
    const shell = {
      name: "matrix-main",
      tabs: [
        { idx: 0, name: "main" },
        { idx: 5, name: "logs" },
      ],
    } as ShellSessionSummary;

    expect(getShellTabCount(shell)).toBe(6);
    expect(formatShellTabCount(shell)).toBe("6 tabs");
  });

  it("falls back to tab array length and handles missing tab lists", () => {
    expect(getShellTabCount({ name: "single", tabs: [{ name: "main" }] } as ShellSessionSummary)).toBe(1);
    expect(formatShellTabCount({ name: "single", tabs: [{ name: "main" }] } as ShellSessionSummary)).toBe("1 tab");
    expect(getShellTabCount({ name: "unknown" } as ShellSessionSummary)).toBeNull();
    expect(formatShellTabCount({ name: "unknown" } as ShellSessionSummary)).toBe("tabs unknown");
  });

  it("filters tree nodes while preserving the matching ancestor chain", () => {
    const filtered = filterTreeNodes(tree, "terminalapp");

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.path).toBe("projects");
    expect(filtered[0]?.expanded).toBe(true);
    expect(filtered[0]?.children).toHaveLength(1);
    expect(filtered[0]?.children?.[0]?.path).toBe("projects/matrix-os");
    expect(filtered[0]?.children?.[0]?.expanded).toBe(true);
    expect(filtered[0]?.children?.[0]?.children?.[0]?.name).toBe("TerminalApp.tsx");
  });

  it("updates a nested tree node without mutating siblings", () => {
    const updated = updateNode(tree, "projects/matrix-os", { expanded: true });

    expect(updated).not.toBe(tree);
    expect(updated[0]).not.toBe(tree[0]);
    expect(updated[0]?.children?.[0]?.expanded).toBe(true);
    expect(updated[0]?.children?.[1]).toBe(tree[0]?.children?.[1]);
  });
});
