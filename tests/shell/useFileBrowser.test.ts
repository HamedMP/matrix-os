import { describe, it, expect, beforeEach, vi } from "vitest";
import { useFileBrowser } from "../../shell/src/hooks/useFileBrowser.js";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("useFileBrowser store", () => {
  beforeEach(() => {
    // Reset the store state
    useFileBrowser.setState({
      currentPath: "",
      history: [""],
      historyIndex: 0,
      viewMode: "icon",
      sortBy: "name",
      sortDirection: "asc",
      showPreviewPanel: false,
      sidebarCollapsed: false,
      entries: [],
      loading: false,
      error: null,
      selectedPaths: new Set(),
      lastSelectedPath: null,
      favorites: [],
      quickLookPath: null,
      searchQuery: "",
      searchResults: null,
      searching: false,
      clipboard: null,
    });
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ path: "", entries: [] }),
    });
  });

  describe("navigation", () => {
    it("navigate sets currentPath and pushes to history", () => {
      useFileBrowser.getState().navigate("agents");
      const state = useFileBrowser.getState();
      expect(state.currentPath).toBe("agents");
      expect(state.history).toEqual(["", "agents"]);
      expect(state.historyIndex).toBe(1);
    });

    it("navigate clears selection and search", () => {
      useFileBrowser.setState({
        selectedPaths: new Set(["a.md"]),
        searchQuery: "test",
        searchResults: [],
      });
      useFileBrowser.getState().navigate("agents");
      const state = useFileBrowser.getState();
      expect(state.selectedPaths.size).toBe(0);
      expect(state.searchQuery).toBe("");
      expect(state.searchResults).toBeNull();
    });

    it("navigate calls fetch with correct URL", () => {
      useFileBrowser.getState().navigate("agents/skills");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/files/list?path=agents%2Fskills"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("goBack moves back in history", () => {
      useFileBrowser.getState().navigate("agents");
      useFileBrowser.getState().navigate("agents/skills");
      useFileBrowser.getState().goBack();
      expect(useFileBrowser.getState().currentPath).toBe("agents");
      expect(useFileBrowser.getState().historyIndex).toBe(1);
    });

    it("goBack does nothing at start of history", () => {
      useFileBrowser.getState().goBack();
      expect(useFileBrowser.getState().currentPath).toBe("");
      expect(useFileBrowser.getState().historyIndex).toBe(0);
    });

    it("goForward moves forward in history", () => {
      useFileBrowser.getState().navigate("agents");
      useFileBrowser.getState().goBack();
      useFileBrowser.getState().goForward();
      expect(useFileBrowser.getState().currentPath).toBe("agents");
    });

    it("goForward does nothing at end of history", () => {
      useFileBrowser.getState().navigate("agents");
      useFileBrowser.getState().goForward();
      expect(useFileBrowser.getState().currentPath).toBe("agents");
    });

    it("navigate after goBack truncates forward history", () => {
      useFileBrowser.getState().navigate("a");
      useFileBrowser.getState().navigate("b");
      useFileBrowser.getState().goBack();
      useFileBrowser.getState().navigate("c");
      expect(useFileBrowser.getState().history).toEqual(["", "a", "c"]);
    });
  });

  describe("view mode", () => {
    it("setViewMode updates viewMode", () => {
      useFileBrowser.getState().setViewMode("list");
      expect(useFileBrowser.getState().viewMode).toBe("list");
    });

    it("setSortBy updates sortBy", () => {
      useFileBrowser.getState().setSortBy("size");
      expect(useFileBrowser.getState().sortBy).toBe("size");
    });

    it("setSortDirection updates sortDirection", () => {
      useFileBrowser.getState().setSortDirection("desc");
      expect(useFileBrowser.getState().sortDirection).toBe("desc");
    });

    it("togglePreviewPanel toggles", () => {
      expect(useFileBrowser.getState().showPreviewPanel).toBe(false);
      useFileBrowser.getState().togglePreviewPanel();
      expect(useFileBrowser.getState().showPreviewPanel).toBe(true);
      useFileBrowser.getState().togglePreviewPanel();
      expect(useFileBrowser.getState().showPreviewPanel).toBe(false);
    });

    it("toggleSidebar toggles", () => {
      expect(useFileBrowser.getState().sidebarCollapsed).toBe(false);
      useFileBrowser.getState().toggleSidebar();
      expect(useFileBrowser.getState().sidebarCollapsed).toBe(true);
    });
  });

  describe("selection", () => {
    it("select replaces selection by default", () => {
      useFileBrowser.getState().select("a.md");
      expect(useFileBrowser.getState().selectedPaths).toEqual(
        new Set(["a.md"]),
      );
      useFileBrowser.getState().select("b.md");
      expect(useFileBrowser.getState().selectedPaths).toEqual(
        new Set(["b.md"]),
      );
    });

    it("select with multi toggles individual items", () => {
      useFileBrowser.getState().select("a.md");
      useFileBrowser.getState().select("b.md", true);
      expect(useFileBrowser.getState().selectedPaths).toEqual(
        new Set(["a.md", "b.md"]),
      );
      useFileBrowser.getState().select("a.md", true);
      expect(useFileBrowser.getState().selectedPaths).toEqual(
        new Set(["b.md"]),
      );
    });

    it("selectAll selects all entries", () => {
      useFileBrowser.setState({
        entries: [
          { name: "a.md", type: "file" },
          { name: "b.md", type: "file" },
          { name: "dir", type: "directory" },
        ],
      });
      useFileBrowser.getState().selectAll();
      expect(useFileBrowser.getState().selectedPaths).toEqual(
        new Set(["a.md", "b.md", "dir"]),
      );
    });

    it("clearSelection clears all", () => {
      useFileBrowser.setState({ selectedPaths: new Set(["a.md", "b.md"]) });
      useFileBrowser.getState().clearSelection();
      expect(useFileBrowser.getState().selectedPaths.size).toBe(0);
    });

    it("tracks lastSelectedPath", () => {
      useFileBrowser.getState().select("a.md");
      expect(useFileBrowser.getState().lastSelectedPath).toBe("a.md");
    });
  });

  describe("clipboard", () => {
    it("copy sets clipboard with copy operation", () => {
      useFileBrowser.getState().copy(["a.md", "b.md"]);
      expect(useFileBrowser.getState().clipboard).toEqual({
        paths: ["a.md", "b.md"],
        operation: "copy",
      });
    });

    it("cut sets clipboard with cut operation", () => {
      useFileBrowser.getState().cut(["a.md"]);
      expect(useFileBrowser.getState().clipboard).toEqual({
        paths: ["a.md"],
        operation: "cut",
      });
    });
  });

  describe("search", () => {
    it("search sets query and searching flag", () => {
      useFileBrowser.getState().search("test");
      expect(useFileBrowser.getState().searchQuery).toBe("test");
      expect(useFileBrowser.getState().searching).toBe(true);
    });

    it("empty search clears results", () => {
      useFileBrowser.setState({
        searchQuery: "old",
        searchResults: [],
        searching: true,
      });
      useFileBrowser.getState().search("");
      expect(useFileBrowser.getState().searchQuery).toBe("");
      expect(useFileBrowser.getState().searchResults).toBeNull();
      expect(useFileBrowser.getState().searching).toBe(false);
    });

    it("clearSearch resets search state", () => {
      useFileBrowser.setState({
        searchQuery: "test",
        searchResults: [],
        searching: true,
      });
      useFileBrowser.getState().clearSearch();
      expect(useFileBrowser.getState().searchQuery).toBe("");
      expect(useFileBrowser.getState().searchResults).toBeNull();
    });
  });

  describe("quick look", () => {
    it("setQuickLookPath sets and clears path", () => {
      useFileBrowser.getState().setQuickLookPath("readme.md");
      expect(useFileBrowser.getState().quickLookPath).toBe("readme.md");
      useFileBrowser.getState().setQuickLookPath(null);
      expect(useFileBrowser.getState().quickLookPath).toBeNull();
    });
  });

  describe("favorites", () => {
    it("toggleFavorite adds new favorite", () => {
      useFileBrowser.getState().toggleFavorite("agents");
      expect(useFileBrowser.getState().favorites).toEqual(["agents"]);
    });

    it("toggleFavorite removes existing favorite", () => {
      useFileBrowser.setState({ favorites: ["agents", "system"] });
      useFileBrowser.getState().toggleFavorite("agents");
      expect(useFileBrowser.getState().favorites).toEqual(["system"]);
    });
  });

  describe("file operations", () => {
    it("createFolder calls mkdir API", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });
      useFileBrowser.setState({ currentPath: "agents" });
      await useFileBrowser.getState().createFolder("new-folder");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/files/mkdir"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ path: "agents/new-folder" }),
        }),
      );
    });

    it("createFile calls touch API", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });
      await useFileBrowser.getState().createFile("new.md");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/files/touch"),
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("deleteFiles calls delete API for each path", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });
      useFileBrowser.setState({ selectedPaths: new Set(["a.md"]) });
      await useFileBrowser.getState().deleteFiles(["a.md", "b.md"]);
      const deleteCalls = mockFetch.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("/api/files/delete"),
      );
      expect(deleteCalls).toHaveLength(2);
      expect(useFileBrowser.getState().selectedPaths.size).toBe(0);
    });

    it("rename calls rename API", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });
      const result = await useFileBrowser
        .getState()
        .rename("old.md", "new.md");
      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/files/rename"),
        expect.objectContaining({
          body: JSON.stringify({ from: "old.md", to: "new.md" }),
        }),
      );
    });
  });
});
