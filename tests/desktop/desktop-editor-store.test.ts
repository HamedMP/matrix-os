import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_DESKTOP_EDITOR_TABS,
  normalizeDesktopEditorPath,
  useDesktopEditor,
} from "@desktop/renderer/src/features/editor/desktop-editor-store";

describe("desktop editor file tabs", () => {
  beforeEach(() => {
    useDesktopEditor.setState(useDesktopEditor.getInitialState(), true);
  });

  it("normalizes Matrix-home absolute paths and rejects traversal or foreign absolute paths", () => {
    expect(normalizeDesktopEditorPath("/home/matrix/home/projects/app/src/main.ts:42:7"))
      .toBe("projects/app/src/main.ts");
    expect(normalizeDesktopEditorPath("~/notes/today.md")).toBe("notes/today.md");
    expect(normalizeDesktopEditorPath("projects/app/package.json")).toBe("projects/app/package.json");
    expect(normalizeDesktopEditorPath("/Users/alice/private.txt")).toBeNull();
    expect(normalizeDesktopEditorPath("~/../system/config.json")).toBeNull();
  });

  it("opens each file once, focuses it, and resets files across runtime identities", () => {
    const editor = useDesktopEditor.getState();
    editor.ensureScope("primary|1");
    expect(editor.openFile("projects/app/src/main.ts")).toBe(true);
    expect(useDesktopEditor.getState()).toMatchObject({
      paths: ["projects/app/src/main.ts"],
      activePath: "projects/app/src/main.ts",
    });

    expect(useDesktopEditor.getState().openFile("projects/app/src/main.ts")).toBe(true);
    expect(useDesktopEditor.getState().paths).toHaveLength(1);

    useDesktopEditor.getState().ensureScope("staging|2");
    expect(useDesktopEditor.getState()).toMatchObject({
      scope: "staging|2",
      paths: [],
      activePath: null,
      dirtyPaths: [],
    });
  });

  it("caps tabs without evicting unsaved documents", () => {
    useDesktopEditor.getState().ensureScope("primary|1");
    for (let index = 0; index < MAX_DESKTOP_EDITOR_TABS; index += 1) {
      const path = `notes/file-${index}.md`;
      expect(useDesktopEditor.getState().openFile(path)).toBe(true);
      useDesktopEditor.getState().setDirty(path, true);
    }

    expect(useDesktopEditor.getState().openFile("notes/overflow.md")).toBe(false);
    expect(useDesktopEditor.getState().paths).toHaveLength(MAX_DESKTOP_EDITOR_TABS);
    expect(useDesktopEditor.getState().paths).not.toContain("notes/overflow.md");
    expect(useDesktopEditor.getState().error).toMatch(/unsaved/i);
  });
});
