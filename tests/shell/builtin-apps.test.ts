import { describe, expect, it } from "vitest";
import {
  DEFAULT_PINNED_APPS,
  isBuiltInAppPath,
  normalizeBuiltInAppPath,
  normalizeBuiltInLayoutWindow,
} from "../../shell/src/lib/builtin-apps";

describe("built-in app helpers", () => {
  it("pins the core workspace launchers by default", () => {
    expect(DEFAULT_PINNED_APPS).toEqual(["__workspace__", "__terminal__", "__file-browser__", "__chat__"]);
  });

  it("normalizes stale Workspace app paths to the shell built-in", () => {
    expect(normalizeBuiltInAppPath("workspace")).toBe("__workspace__");
    expect(normalizeBuiltInAppPath("apps/workspace/index.html")).toBe("__workspace__");
    expect(normalizeBuiltInAppPath("/files/apps/workspace/index.html")).toBe("__workspace__");
  });

  it("identifies terminal instances and normalized built-ins", () => {
    expect(isBuiltInAppPath("__terminal__:1712345678-a3bc")).toBe(true);
    expect(isBuiltInAppPath("apps/workspace/index.html")).toBe(true);
    expect(isBuiltInAppPath("apps/notes/index.html")).toBe(false);
  });

  it("normalizes saved Workspace layout entries before restoration", () => {
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
