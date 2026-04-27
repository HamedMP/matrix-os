// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceCanvasStore } from "../../shell/src/stores/workspace-canvas-store.js";

const document = {
  id: "cnv_0123456789abcdef",
  title: "PR 57",
  revision: 1,
  schemaVersion: 1,
  scopeType: "pull_request",
  scopeRef: { projectId: "prj_1" },
  nodes: [],
  edges: [],
  viewStates: [],
  displayOptions: {},
};

describe("workspace canvas store", () => {
  beforeEach(() => {
    useWorkspaceCanvasStore.setState({
      summaries: [],
      activeCanvasId: null,
      document: null,
      linkedState: null,
      selectedNodeId: null,
      focusedNodeId: null,
      query: "",
      filters: [],
      saveStatus: "idle",
      error: null,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ document, linkedState: {} }) }));
  });

  it("loads a PR canvas document and linked summaries", async () => {
    await useWorkspaceCanvasStore.getState().openCanvas("cnv_0123456789abcdef");
    expect(useWorkspaceCanvasStore.getState().document?.scopeType).toBe("pull_request");
    expect(useWorkspaceCanvasStore.getState().linkedState).toEqual({});
  });

  it("creates PR canvases, saves optimistically, and rolls back conflicts by refetching", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ canvasId: "cnv_0123456789abcdef", revision: 1 }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ document, linkedState: {} }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ canvases: [] }) })
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: "Canvas conflict" }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ document: { ...document, revision: 2 }, linkedState: {} }) });
    vi.stubGlobal("fetch", fetchMock);

    await useWorkspaceCanvasStore.getState().openPrCanvas({ projectId: "prj_1" });
    await useWorkspaceCanvasStore.getState().saveDocument(document as any);

    expect(useWorkspaceCanvasStore.getState().document?.revision).toBe(2);
    expect(useWorkspaceCanvasStore.getState().saveStatus).toBe("conflict");
  });

  it("records PR canvas creation failures and refreshes summaries", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: "Canvas request failed" }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ canvases: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    await useWorkspaceCanvasStore.getState().openPrCanvas({ projectId: "prj_1" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useWorkspaceCanvasStore.getState().error).toBe("Canvas request failed");
    expect(useWorkspaceCanvasStore.getState().activeCanvasId).toBeNull();
  });

  it("records delete failures without clearing the active canvas", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: "Canvas not found" }) });
    vi.stubGlobal("fetch", fetchMock);
    useWorkspaceCanvasStore.setState({
      activeCanvasId: document.id,
      document: document as any,
    });

    await useWorkspaceCanvasStore.getState().deleteCanvas();

    expect(useWorkspaceCanvasStore.getState().document?.id).toBe(document.id);
    expect(useWorkspaceCanvasStore.getState().error).toBe("Canvas not found");
  });

  it("filters and focuses visible nodes", () => {
    useWorkspaceCanvasStore.setState({ document: { ...document, nodes: [
      { id: "node_terminal", type: "terminal", position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, zIndex: 0, displayState: "normal", sourceRef: null, metadata: { label: "Term" } },
      { id: "node_note", type: "note", position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, zIndex: 0, displayState: "normal", sourceRef: null, metadata: { text: "Alpha" } },
    ] } as any });
    useWorkspaceCanvasStore.getState().setQuery("alpha");
    useWorkspaceCanvasStore.getState().setFocusedNode("node_note");
    expect(useWorkspaceCanvasStore.getState().visibleNodes()).toHaveLength(1);
    expect(useWorkspaceCanvasStore.getState().focusedNodeId).toBe("node_note");
  });

  it("does not switch back to a stale canvas after a save conflict", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: "Canvas conflict" }) });
    vi.stubGlobal("fetch", fetchMock);
    useWorkspaceCanvasStore.setState({
      activeCanvasId: "cnv_other123456789",
      document: { ...document, id: "cnv_other123456789" } as any,
    });

    await useWorkspaceCanvasStore.getState().saveDocument(document as any);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useWorkspaceCanvasStore.getState().activeCanvasId).toBe("cnv_other123456789");
    expect(useWorkspaceCanvasStore.getState().saveStatus).toBe("conflict");
  });
});
