import { describe, expect, it } from "vitest";
import {
  formatShellDisplayName,
  formatShellTabCount,
  getShellTabCount,
} from "../../shell/src/components/terminal/TerminalSidebarItems.js";
import type { ShellSessionSummary } from "../../shell/src/components/terminal/terminal-session-state.js";

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
});
