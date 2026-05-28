import { afterEach, describe, expect, it, vi } from "vitest";
import { openAppInStandaloneTab } from "../../shell/src/lib/open-app-tab.js";

describe("openAppInStandaloneTab security", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not open generated app content outside the iframe sandbox", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });

    openAppInStandaloneTab("apps/notes/index.html");

    expect(open).not.toHaveBeenCalled();
  });

  it("does not open arbitrary files as top-level same-origin pages", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });

    openAppInStandaloneTab("uploads/report.html");

    expect(open).not.toHaveBeenCalled();
  });
});
