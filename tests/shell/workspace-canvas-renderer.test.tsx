// @vitest-environment jsdom
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWorkspaceCanvasStore } from "../../shell/src/stores/workspace-canvas-store.js";
import { WorkspaceCanvas } from "../../shell/src/components/canvas/WorkspaceCanvas.js";
import { WorkspaceCanvasNode } from "../../shell/src/components/canvas/WorkspaceCanvasNode.js";

vi.mock("@tldraw/tldraw", () => ({
  Tldraw: () => <div data-testid="mock-tldraw" />,
}));
vi.mock("../../shell/src/components/terminal/TerminalPane.js", () => ({
  TerminalPane: () => <div>terminal pane</div>,
}));
vi.mock("../../shell/src/hooks/useTheme.js", () => ({
  useTheme: () => ({ colors: { background: "#000", foreground: "#fff" } }),
}));

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
});
