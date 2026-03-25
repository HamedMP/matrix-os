import { describe, it, expect, beforeEach } from "vitest";
import {
  usePreviewWindow,
  detectFileType,
} from "../../shell/src/hooks/usePreviewWindow.js";

describe("usePreviewWindow store", () => {
  beforeEach(() => {
    usePreviewWindow.setState({
      tabs: [],
      activeTabId: null,
      unsavedTabs: new Set(),
    });
  });

  describe("openFile", () => {
    it("opens a new tab and sets it active", () => {
      usePreviewWindow.getState().openFile("agents/builder.md");
      const state = usePreviewWindow.getState();
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0].path).toBe("agents/builder.md");
      expect(state.tabs[0].name).toBe("builder.md");
      expect(state.tabs[0].type).toBe("markdown");
      expect(state.tabs[0].mode).toBe("preview");
      expect(state.activeTabId).toBe(state.tabs[0].id);
    });

    it("focuses existing tab instead of duplicating", () => {
      usePreviewWindow.getState().openFile("a.md");
      usePreviewWindow.getState().openFile("b.ts");
      usePreviewWindow.getState().openFile("a.md");
      const state = usePreviewWindow.getState();
      expect(state.tabs).toHaveLength(2);
      expect(state.activeTabId).toBe(
        state.tabs.find((t) => t.path === "a.md")!.id,
      );
    });

    it("detects file types correctly", () => {
      usePreviewWindow.getState().openFile("app.tsx");
      expect(usePreviewWindow.getState().tabs[0].type).toBe("code");
      expect(usePreviewWindow.getState().tabs[0].mode).toBe("source");
    });
  });

  describe("closeTab", () => {
    it("removes the tab", () => {
      usePreviewWindow.getState().openFile("a.md");
      const tab = usePreviewWindow.getState().tabs[0];
      usePreviewWindow.getState().closeTab(tab.id);
      expect(usePreviewWindow.getState().tabs).toHaveLength(0);
      expect(usePreviewWindow.getState().activeTabId).toBeNull();
    });

    it("selects adjacent tab when closing active", () => {
      usePreviewWindow.getState().openFile("a.md");
      usePreviewWindow.getState().openFile("b.md");
      usePreviewWindow.getState().openFile("c.md");
      const tabs = usePreviewWindow.getState().tabs;
      // Active is c.md (last opened)
      usePreviewWindow.getState().setActiveTab(tabs[1].id);
      usePreviewWindow.getState().closeTab(tabs[1].id);
      // Should select c.md (now at index 1)
      const remaining = usePreviewWindow.getState().tabs;
      expect(remaining).toHaveLength(2);
      expect(usePreviewWindow.getState().activeTabId).toBe(remaining[1].id);
    });

    it("selects last tab when closing last position", () => {
      usePreviewWindow.getState().openFile("a.md");
      usePreviewWindow.getState().openFile("b.md");
      const tabs = usePreviewWindow.getState().tabs;
      usePreviewWindow.getState().setActiveTab(tabs[1].id);
      usePreviewWindow.getState().closeTab(tabs[1].id);
      expect(usePreviewWindow.getState().activeTabId).toBe(
        usePreviewWindow.getState().tabs[0].id,
      );
    });

    it("clears unsaved state for closed tab", () => {
      usePreviewWindow.getState().openFile("a.md");
      const tab = usePreviewWindow.getState().tabs[0];
      usePreviewWindow.getState().markUnsaved(tab.id);
      usePreviewWindow.getState().closeTab(tab.id);
      expect(usePreviewWindow.getState().unsavedTabs.has(tab.id)).toBe(false);
    });
  });

  describe("setMode", () => {
    it("changes mode for text/code/markdown tabs", () => {
      usePreviewWindow.getState().openFile("readme.md");
      const tab = usePreviewWindow.getState().tabs[0];
      usePreviewWindow.getState().setMode(tab.id, "source");
      expect(usePreviewWindow.getState().tabs[0].mode).toBe("source");
      usePreviewWindow.getState().setMode(tab.id, "wysiwyg");
      expect(usePreviewWindow.getState().tabs[0].mode).toBe("wysiwyg");
    });

    it("no-ops for image/pdf/audio/video tabs", () => {
      usePreviewWindow.getState().openFile("photo.png");
      const tab = usePreviewWindow.getState().tabs[0];
      usePreviewWindow.getState().setMode(tab.id, "source");
      expect(usePreviewWindow.getState().tabs[0].mode).toBeUndefined();
    });
  });

  describe("unsaved state", () => {
    it("markUnsaved adds to unsavedTabs", () => {
      usePreviewWindow.getState().openFile("a.md");
      const tab = usePreviewWindow.getState().tabs[0];
      usePreviewWindow.getState().markUnsaved(tab.id);
      expect(usePreviewWindow.getState().unsavedTabs.has(tab.id)).toBe(true);
    });

    it("markSaved removes from unsavedTabs", () => {
      usePreviewWindow.getState().openFile("a.md");
      const tab = usePreviewWindow.getState().tabs[0];
      usePreviewWindow.getState().markUnsaved(tab.id);
      usePreviewWindow.getState().markSaved(tab.id);
      expect(usePreviewWindow.getState().unsavedTabs.has(tab.id)).toBe(false);
    });
  });

  describe("reorderTabs", () => {
    it("reorders tabs by index", () => {
      usePreviewWindow.getState().openFile("a.md");
      usePreviewWindow.getState().openFile("b.md");
      usePreviewWindow.getState().openFile("c.md");
      usePreviewWindow.getState().reorderTabs(2, 0);
      const names = usePreviewWindow.getState().tabs.map((t) => t.name);
      expect(names).toEqual(["c.md", "a.md", "b.md"]);
    });
  });
});

describe("detectFileType", () => {
  it("detects markdown", () => expect(detectFileType("readme.md")).toBe("markdown"));
  it("detects code", () => expect(detectFileType("app.tsx")).toBe("code"));
  it("detects text", () => expect(detectFileType("notes.txt")).toBe("text"));
  it("detects image", () => expect(detectFileType("photo.png")).toBe("image"));
  it("detects pdf", () => expect(detectFileType("doc.pdf")).toBe("pdf"));
  it("detects audio", () => expect(detectFileType("song.mp3")).toBe("audio"));
  it("detects video", () => expect(detectFileType("clip.mp4")).toBe("video"));
  it("defaults to text for unknown", () => expect(detectFileType("file.xyz")).toBe("text"));
});
