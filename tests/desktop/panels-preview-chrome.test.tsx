// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  const openExternal = vi.fn(async () => ({ ok: true }));
  let refreshSpy: ReturnType<typeof vi.fn>;
  let originalRefresh: () => Promise<void>;

  beforeEach(() => {
    openExternal.mockClear();
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === "shell:open-external") return openExternal();
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
    return render(
      <Tooltip.Provider>
        <InspectorPreviewPanel summary={summary} />
      </Tooltip.Provider>,
    );
  }

  it("shows a graceful empty state when no previews exist", () => {
    renderPanel(summaryWith([]));
    expect(screen.getByText(/No previews/)).toBeTruthy();
  });

  it("lists previews and opens one with a chrome row showing its URL", () => {
    renderPanel(summaryWith([
      preview({ id: "pv_1", label: "Web app" }),
      preview({ id: "pv_2", label: "Storybook", origin: "https://sb.example.com" }),
    ]));

    fireEvent.click(screen.getByRole("button", { name: "Inspect preview Web app" }));

    expect(screen.getByText("https://preview.example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh previews" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open preview Web app in browser" })).toBeTruthy();
    // The list is replaced by the focused preview, not stacked.
    expect(screen.queryByRole("button", { name: "Inspect preview Storybook" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to previews" }));
    expect(screen.getByRole("button", { name: "Inspect preview Storybook" })).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Open preview Web app in browser" }));
    expect(window.operator.invoke).toHaveBeenCalledWith("shell:open-external", { url: "https://preview.example.com" });

    fireEvent.click(screen.getByRole("button", { name: "Back to previews" }));
    fireEvent.click(screen.getByRole("button", { name: "Inspect preview Local only" }));

    const blocked = screen.getByRole("button", { name: "Open in browser" });
    expect(blocked.hasAttribute("disabled")).toBe(true);
    expect(window.operator.invoke).toHaveBeenCalledTimes(1);
  });

  it("falls back to the list when the inspected preview disappears", () => {
    const view = renderPanel(summaryWith([preview({ id: "pv_1", label: "Web app" })]));
    fireEvent.click(screen.getByRole("button", { name: "Inspect preview Web app" }));
    expect(screen.getByText("https://preview.example.com")).toBeTruthy();

    view.rerender(
      <Tooltip.Provider>
        <InspectorPreviewPanel summary={summaryWith([])} />
      </Tooltip.Provider>,
    );

    expect(screen.getByText(/No previews/)).toBeTruthy();
    expect(screen.queryByText("https://preview.example.com")).toBeNull();
  });
});
