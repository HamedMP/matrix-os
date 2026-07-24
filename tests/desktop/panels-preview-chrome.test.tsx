// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewSessionSummary, RuntimeSummary } from "@matrix-os/contracts";
import { InspectorPreviewPanel } from "../../desktop/src/renderer/src/features/panels/InspectorPreviewPanel";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";

const NOW = "2026-07-12T12:00:00.000Z";

function preview(partial: Partial<PreviewSessionSummary> & { id: string; label: string }): PreviewSessionSummary {
  return {
    status: "running",
    origin: "https://preview.example.com",
    updatedAt: NOW,
    ...partial,
  };
}

function summaryWith(previews: PreviewSessionSummary[]): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [],
    providers: [],
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items: [], hasMore: false, limit: 20 },
    previewSessions: { items: previews, hasMore: false, limit: 50 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: { maxPromptBytes: 16_384, maxAttachmentCount: 8, maxTerminalInputBytes: 8_192, maxListItems: 20 },
    serverTime: NOW,
  };
}

describe("InspectorPreviewPanel", () => {
  let refreshSpy: ReturnType<typeof vi.fn>;
  let originalRefresh: () => Promise<void>;

  beforeEach(() => {
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === "shell:open-external") return { ok: true };
          throw new Error(`unexpected channel ${channel}`);
        }),
        on: vi.fn(() => () => undefined),
      },
    });
    originalRefresh = useCodingAgentWorkspace.getState().refresh;
    refreshSpy = vi.fn(async () => {});
    useCodingAgentWorkspace.setState({ refresh: refreshSpy });
  });

  afterEach(() => {
    useCodingAgentWorkspace.setState({ refresh: originalRefresh });
    cleanup();
    vi.restoreAllMocks();
  });

  function renderPanel(summary: RuntimeSummary) {
    return render(<InspectorPreviewPanel summary={summary} />);
  }

  it("shows a graceful empty state when no previews exist", () => {
    renderPanel(summaryWith([]));
    expect(screen.getByText(/No previews/)).toBeTruthy();
  });

  it("keeps the list visible and adds a chrome row for the inspected preview", () => {
    renderPanel(summaryWith([
      preview({ id: "pv_1", label: "Web app" }),
      preview({ id: "pv_2", label: "Storybook", origin: "https://sb.example.com" }),
    ]));

    fireEvent.click(screen.getByRole("button", { name: "Inspect preview Web app" }));

    // Chrome row: URL display, refresh, open-external.
    expect(screen.getAllByText("https://preview.example.com").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: "Refresh previews" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open preview in browser" })).toBeTruthy();
    expect(screen.getByText("Preview details")).toBeTruthy();
    // The list stays — another preview can be inspected without going back,
    // and the details/chrome follow the new selection.
    fireEvent.click(screen.getByRole("button", { name: "Inspect preview Storybook" }));
    const details = screen.getByLabelText("Preview details for Storybook");
    expect(within(details).getByText("https://sb.example.com")).toBeTruthy();
    expect(within(details).queryByText("https://preview.example.com")).toBeNull();
  });

  it("refreshes preview state from the chrome row", () => {
    renderPanel(summaryWith([preview({ id: "pv_1", label: "Web app" })]));
    fireEvent.click(screen.getByRole("button", { name: "Inspect preview Web app" }));

    fireEvent.click(screen.getByRole("button", { name: "Refresh previews" }));

    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it("opens HTTPS previews externally through the bridge and blocks others", () => {
    renderPanel(summaryWith([
      preview({ id: "pv_1", label: "Web app" }),
      preview({ id: "pv_2", label: "Local only", origin: "http://localhost:8080" }),
    ]));

    fireEvent.click(screen.getByRole("button", { name: "Inspect preview Web app" }));
    fireEvent.click(screen.getByRole("button", { name: "Open preview in browser" }));
    expect(window.operator.invoke).toHaveBeenCalledWith("shell:open-external", { url: "https://preview.example.com" });

    fireEvent.click(screen.getByRole("button", { name: "Inspect preview Local only" }));

    const blocked = screen.getByRole("button", { name: "Open preview in browser" });
    expect(blocked.hasAttribute("disabled")).toBe(true);
    expect(window.operator.invoke).toHaveBeenCalledTimes(1);
  });

  it("clears the chrome when the inspected preview disappears", () => {
    const view = renderPanel(summaryWith([preview({ id: "pv_1", label: "Web app" })]));
    fireEvent.click(screen.getByRole("button", { name: "Inspect preview Web app" }));
    expect(screen.getByText("Preview details")).toBeTruthy();

    view.rerender(<InspectorPreviewPanel summary={summaryWith([])} />);

    expect(screen.getByText(/No previews/)).toBeTruthy();
    expect(screen.queryByText("Preview details")).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh previews" })).toBeNull();
  });

  it("renders inside the shared tooltip context without requiring one of its own", () => {
    render(
      <Tooltip.Provider>
        <InspectorPreviewPanel summary={summaryWith([preview({ id: "pv_1", label: "Web app" })])} />
      </Tooltip.Provider>,
    );
    expect(screen.getByRole("button", { name: "Inspect preview Web app" })).toBeTruthy();
  });
});
