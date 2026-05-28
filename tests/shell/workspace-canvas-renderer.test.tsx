// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasRenderer } from "../../shell/src/components/canvas/CanvasRenderer.js";
import { useWorkspaceCanvasStore } from "../../shell/src/stores/workspace-canvas-store.js";
import { useCanvasTransform } from "../../shell/src/hooks/useCanvasTransform.js";
import { WorkspaceCanvas, WorkspaceCanvasLayer } from "../../shell/src/components/canvas/WorkspaceCanvas.js";
import { WorkspaceCanvasNode } from "../../shell/src/components/canvas/WorkspaceCanvasNode.js";

const originalUpdateNode = useWorkspaceCanvasStore.getState().updateNode;

vi.mock("@tldraw/tldraw", () => ({
  Tldraw: () => <div data-testid="mock-tldraw" />,
}));
vi.mock("../../shell/src/components/terminal/TerminalPane.js", () => ({
  TerminalPane: () => <div>terminal pane</div>,
}));
vi.mock("../../shell/src/hooks/useTheme.js", () => ({
  useTheme: () => ({ colors: { background: "#000", foreground: "#fff" } }),
}));

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function node(type: any, metadata: Record<string, unknown> = {}) {
  return {
    id: `node_${type}`,
    type,
    position: { x: 0, y: 0 },
    size: { width: 320, height: 180 },
    zIndex: 0,
    displayState: "normal",
    sourceRef: type === "terminal" ? { kind: "terminal_session", id: "550e8400-e29b-41d4-a716-446655440000" } : null,
    metadata,
  };
}

describe("workspace canvas renderer", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock as unknown as typeof ResizeObserver);
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 1600, height: 900, close: vi.fn() }));
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/assets")) {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve({
            assetId: "asset_0123456789abcdef",
            path: "system/canvas-assets/cnv_0123456789abcdef/asset_0123456789abcdef.png",
            mimeType: "image/png",
            sizeBytes: 8,
            originalName: "screenshot.png",
          }),
        });
      }
      if (url.includes("/api/canvases/cnv_0123456789abcdef")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ revision: 2, updatedAt: "2026-05-27T00:00:00.000Z" }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ canvases: [] }) });
    }));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 800,
      right: 1000,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    useCanvasTransform.setState({ zoom: 1, panX: 10, panY: 20, containerRect: { left: 0, top: 0, width: 1000, height: 800 }, isAnimating: false, isScrolling: false });
    useWorkspaceCanvasStore.setState({
      summaries: [],
      activeCanvasId: "cnv_0123456789abcdef",
      document: {
        id: "cnv_0123456789abcdef",
        title: "Global Canvas",
        revision: 1,
        schemaVersion: 1,
        scopeType: "global",
        scopeRef: null,
        nodes: [],
        edges: [],
        viewStates: [],
        displayOptions: {},
      } as any,
      linkedState: null,
      selectedNodeId: null,
      focusedNodeId: null,
      query: "",
      filters: [],
      saveStatus: "idle",
      error: null,
      updateNode: originalUpdateNode,
    });
  });

  it("renders PR, task, review, finding, terminal, custom, and fallback nodes", () => {
    for (const item of [
      node("pr", { number: 57, owner: "acme", repo: "app" }),
      node("task", { text: "Task" }),
      node("review_loop", { state: "idle" }),
      node("finding", { summary: "Finding" }),
      node("terminal", { label: "Term" }),
      node("custom", { customType: "local", customVersion: 1, label: "Custom" }),
      { ...node("fallback"), displayState: "recoverable", metadata: { recoveryReason: "missing_reference" } },
    ]) {
      const { unmount } = render(<WorkspaceCanvasNode node={item as any} />);
      expect(document.body.textContent).toBeTruthy();
      unmount();
    }
  });

  it("shows review actions and recoverable state details through rendered text", () => {
    render(<WorkspaceCanvasNode node={node("review_loop", { state: "idle" }) as any} />);
    expect(screen.getByText(/State:/)).toBeTruthy();
  });

  it("renders an empty workspace canvas without unstable selector loops", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ canvases: [] }) }));
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

    render(<WorkspaceCanvas />);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("mock-tldraw")).toBeNull();
  });

  it("mounts tldraw only when the active document opts into the backing layer", () => {
    useWorkspaceCanvasStore.setState({
      document: {
        id: "cnv_0123456789abcdef",
        title: "PR 57",
        revision: 1,
        schemaVersion: 1,
        scopeType: "pull_request",
        scopeRef: null,
        nodes: [],
        edges: [],
        viewStates: [],
        displayOptions: { tldrawLayer: true },
      } as any,
    });

    render(<WorkspaceCanvas />);

    expect(screen.getByTestId("mock-tldraw")).toBeTruthy();
  });

  it("renders image nodes from canvas asset file references", () => {
    render(
      <WorkspaceCanvasNode
        node={{
          ...node("image", { originalName: "Screenshot.png", width: 1280, height: 720 }),
          sourceRef: { kind: "file", id: "system/canvas-assets/cnv_0123456789abcdef/asset_0123456789abcdef.png" },
        } as any}
      />,
    );

    const image = screen.getByAltText("Screenshot.png") as HTMLImageElement;
    expect(image.src).toContain("/files/system/canvas-assets/cnv_0123456789abcdef/asset_0123456789abcdef.png");
  });

  it("pastes clipboard images into the current viewport center as persisted image nodes", async () => {
    render(<CanvasRenderer />);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => new File([Buffer.from("fake-png")], "screenshot.png", { type: "image/png" }),
          },
        ],
        files: [],
      },
    });

    window.dispatchEvent(event);

    await waitFor(() => {
      const imageNode = useWorkspaceCanvasStore.getState().document?.nodes.find((item) => item.type === "image");
      expect(imageNode).toBeTruthy();
      expect(imageNode?.position).toEqual({ x: 170, y: 200 });
      expect(imageNode?.size).toEqual({ width: 640, height: 360 });
      expect(imageNode?.sourceRef).toEqual({
        kind: "file",
        id: "system/canvas-assets/cnv_0123456789abcdef/asset_0123456789abcdef.png",
      });
    });
  });

  it("does not finish a pasted image into a different active canvas", async () => {
    let resolveUpload: (response: Response) => void = () => {};
    const uploadPromise = new Promise<Response>((resolve) => {
      resolveUpload = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/assets")) return uploadPromise;
      if (url.includes("/api/canvases/cnv_0123456789abcdef")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ revision: 2, updatedAt: "2026-05-27T00:00:00.000Z" }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ canvases: [] }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CanvasRenderer />);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => new File([Buffer.from("fake-png")], "screenshot.png", { type: "image/png" }),
          },
        ],
        files: [],
      },
    });

    window.dispatchEvent(event);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/assets"), expect.any(Object)));
    useWorkspaceCanvasStore.setState({
      activeCanvasId: "cnv_other123456789",
      document: {
        id: "cnv_other123456789",
        title: "Other Canvas",
        revision: 1,
        schemaVersion: 1,
        scopeType: "global",
        scopeRef: null,
        nodes: [],
        edges: [],
        viewStates: [],
        displayOptions: {},
      } as any,
    });

    resolveUpload({
      ok: true,
      status: 201,
      json: () => Promise.resolve({
        assetId: "asset_0123456789abcdef",
        path: "system/canvas-assets/cnv_0123456789abcdef/asset_0123456789abcdef.png",
        mimeType: "image/png",
        sizeBytes: 8,
        originalName: "screenshot.png",
      }),
    } as Response);

    await waitFor(() => {
      expect(useWorkspaceCanvasStore.getState().document?.id).toBe("cnv_other123456789");
      expect(useWorkspaceCanvasStore.getState().document?.nodes).toEqual([]);
    });
  });

  it("commits image drags once on pointer release instead of every pointer move", () => {
    const updateNode = vi.fn(useWorkspaceCanvasStore.getState().updateNode);
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: vi.fn() });
    useCanvasTransform.setState({ zoom: 2 });
    useWorkspaceCanvasStore.setState({
      updateNode: updateNode as any,
      document: {
        id: "cnv_0123456789abcdef",
        title: "Global Canvas",
        revision: 1,
        schemaVersion: 1,
        scopeType: "global",
        scopeRef: null,
        nodes: [{
          id: "node_image",
          type: "image",
          position: { x: 100, y: 200 },
          size: { width: 640, height: 360 },
          zIndex: 0,
          displayState: "normal",
          sourceRef: { kind: "file", id: "system/canvas-assets/cnv_0123456789abcdef/asset.png" },
          metadata: { originalName: "Screenshot.png" },
        }],
        edges: [],
        viewStates: [],
        displayOptions: {},
      } as any,
    });

    render(<WorkspaceCanvasLayer />);
    const wrapper = screen.getByAltText("Screenshot.png").closest(".pointer-events-auto") as HTMLElement;

    fireEvent.pointerDown(wrapper, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(wrapper, { pointerId: 1, clientX: 140, clientY: 120 });

    expect(updateNode).not.toHaveBeenCalled();

    fireEvent.pointerUp(wrapper, { pointerId: 1 });

    expect(updateNode).toHaveBeenCalledTimes(1);
    expect(updateNode).toHaveBeenCalledWith("node_image", { position: { x: 120, y: 210 } });
  });

  it("reverts image drag previews when the pointer is cancelled", () => {
    const updateNode = vi.fn(useWorkspaceCanvasStore.getState().updateNode);
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
    useCanvasTransform.setState({ zoom: 2 });
    useWorkspaceCanvasStore.setState({
      updateNode: updateNode as any,
      document: {
        id: "cnv_0123456789abcdef",
        title: "Global Canvas",
        revision: 1,
        schemaVersion: 1,
        scopeType: "global",
        scopeRef: null,
        nodes: [{
          id: "node_image",
          type: "image",
          position: { x: 100, y: 200 },
          size: { width: 640, height: 360 },
          zIndex: 0,
          displayState: "normal",
          sourceRef: { kind: "file", id: "system/canvas-assets/cnv_0123456789abcdef/asset.png" },
          metadata: { originalName: "Screenshot.png" },
        }],
        edges: [],
        viewStates: [],
        displayOptions: {},
      } as any,
    });

    render(<WorkspaceCanvasLayer />);
    const wrapper = screen.getByAltText("Screenshot.png").closest(".pointer-events-auto") as HTMLElement;

    fireEvent.pointerDown(wrapper, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(wrapper, { pointerId: 1, clientX: 140, clientY: 120 });
    fireEvent.pointerCancel(wrapper, { pointerId: 1 });

    expect(updateNode).toHaveBeenCalledTimes(1);
    expect(updateNode).toHaveBeenCalledWith("node_image", { position: { x: 100, y: 200 } });
  });

  it("does not paste canvas images while an editable element owns focus", async () => {
    render(
      <>
        <textarea aria-label="Editor" />
        <CanvasRenderer />
      </>,
    );
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => new File([Buffer.from("fake-png")], "screenshot.png", { type: "image/png" }),
          },
        ],
        files: [],
      },
    });

    fireEvent(screen.getByLabelText("Editor"), event);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useWorkspaceCanvasStore.getState().document?.nodes).toEqual([]);
  });
});
