import { describe, expect, it } from "vitest";
import {
  DEFAULT_PINNED_APPS,
  TERMINAL_MIN_WINDOW_HEIGHT,
  TERMINAL_MIN_WINDOW_WIDTH,
  isBuiltInAppPath,
  isRestorableBuiltInAppPath,
  isRetiredBuiltInAppPath,
  normalizeBuiltInAppPath,
  normalizeBuiltInLayoutWindow,
} from "../../shell/src/lib/builtin-apps";

describe("built-in app helpers", () => {
  it("starts without default pinned apps", () => {
    expect(DEFAULT_PINNED_APPS).toEqual([]);
  });

  it("normalizes stale Workspace paths only to a non-restorable tombstone", () => {
    expect(normalizeBuiltInAppPath("workspace")).toBe("__workspace__");
    expect(normalizeBuiltInAppPath("apps/workspace/index.html")).toBe("__workspace__");
    expect(normalizeBuiltInAppPath("/files/apps/workspace/index.html")).toBe("__workspace__");
    expect(isRetiredBuiltInAppPath("__workspace__")).toBe(true);
    expect(isRestorableBuiltInAppPath("__workspace__")).toBe(false);
  });

  it("identifies terminal instances and normalized built-ins", () => {
    expect(isBuiltInAppPath("__terminal__:1712345678-a3bc")).toBe(true);
    expect(isBuiltInAppPath("apps/workspace/index.html")).toBe(true);
    expect(isRestorableBuiltInAppPath("__terminal__")).toBe(true);
    expect(isBuiltInAppPath("apps/notes/index.html")).toBe(false);
  });

  it("normalizes legacy terminal instance paths to the singleton Terminal app", () => {
    expect(normalizeBuiltInAppPath("__terminal__:1712345678-a3bc")).toBe("__terminal__");
    expect(normalizeBuiltInLayoutWindow({
      path: "__terminal__:1712345678-a3bc",
      title: "matrix-x6mb8y2",
      x: 10,
      y: 20,
      width: 800,
      height: 600,
      state: "open",
    })).toMatchObject({
      path: "__terminal__",
      title: "Terminal",
      width: TERMINAL_MIN_WINDOW_WIDTH,
      height: TERMINAL_MIN_WINDOW_HEIGHT,
    });
  });

  it("keeps saved Workspace layout entries identifiable for retirement filtering", () => {
    expect(normalizeBuiltInLayoutWindow({
      path: "apps/workspace/index.html",
      title: "workspace",
      x: 10,
      y: 20,
      width: 800,
      height: 600,
      state: "open",
    })).toMatchObject({
      path: "__workspace__",
      title: "Workspace",
    });
  });
});
