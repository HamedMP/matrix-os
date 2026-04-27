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

  it("creates PR canvases, saves optimistically, and keeps local edits on conflicts", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ canvasId: "cnv_0123456789abcdef", revision: 1 }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ document, linkedState: {} }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ canvases: [] }) })
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: "Canvas conflict" }) });
    vi.stubGlobal("fetch", fetchMock);

    await useWorkspaceCanvasStore.getState().openPrCanvas({ projectId: "prj_1" });
    await useWorkspaceCanvasStore.getState().saveDocument(document as any);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(useWorkspaceCanvasStore.getState().document?.revision).toBe(1);
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

  it("does not surface raw server internals from canvas errors", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: "postgres constraint failed at /home/deploy/secret" }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ canvases: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    await useWorkspaceCanvasStore.getState().openPrCanvas({ projectId: "prj_1" });

    expect(useWorkspaceCanvasStore.getState().error).toBe("Canvas request failed");
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

  it("removes deleted canvases from summaries before refreshing", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) })
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: "Canvas request failed" }) });
    vi.stubGlobal("fetch", fetchMock);
    useWorkspaceCanvasStore.setState({
      activeCanvasId: document.id,
      document: document as any,
      summaries: [
        { id: document.id, title: "PR 57", scopeType: "pull_request", scopeRef: null, revision: 1, updatedAt: "2026-04-27T00:00:00.000Z", nodeCounts: { total: 0, stale: 0, live: 0 } },
      ],
    });

    await useWorkspaceCanvasStore.getState().deleteCanvas();

    expect(useWorkspaceCanvasStore.getState().document).toBeNull();
    expect(useWorkspaceCanvasStore.getState().summaries).toEqual([]);
  });

  it("records export failures without throwing", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: "Canvas request failed" }) });
    vi.stubGlobal("fetch", fetchMock);
    useWorkspaceCanvasStore.setState({ document: document as any });

    await expect(useWorkspaceCanvasStore.getState().exportCanvas()).resolves.toBeNull();
    expect(useWorkspaceCanvasStore.getState().error).toBe("Canvas request failed");
  });

  it("creates unique edge ids within the same millisecond", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_776_729_600_000);
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.111111111)
      .mockReturnValueOnce(0.222222222);
    useWorkspaceCanvasStore.setState({
      document: {
        ...document,
        nodes: [
          { id: "node_a", type: "note", position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, zIndex: 0, displayState: "normal", sourceRef: null, metadata: {} },
          { id: "node_b", type: "note", position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, zIndex: 0, displayState: "normal", sourceRef: null, metadata: {} },
        ],
      } as any,
    });

    await useWorkspaceCanvasStore.getState().addEdge("node_a", "node_b");
    await useWorkspaceCanvasStore.getState().addEdge("node_b", "node_a");

    const ids = useWorkspaceCanvasStore.getState().document?.edges.map((edge) => edge.id) ?? [];
    expect(new Set(ids).size).toBe(2);
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
    expect(useWorkspaceCanvasStore.getState().document?.id).toBe("cnv_other123456789");
    expect(useWorkspaceCanvasStore.getState().saveStatus).toBe("conflict");
  });
});
