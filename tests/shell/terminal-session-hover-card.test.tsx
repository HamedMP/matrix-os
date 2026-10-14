// @vitest-environment jsdom

import React from "react";
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalSessionHoverCard } from "../../shell/src/components/terminal/TerminalSessionHoverCard.js";
import type { ShellSessionSummary } from "../../shell/src/components/terminal/terminal-session-state.js";
import { useCanvasTransform } from "../../shell/src/hooks/useCanvasTransform.js";

function renderHoverCard(shell: ShellSessionSummary, canvasZoom = 1) {
  const anchor = document.createElement("div");
  Object.defineProperty(anchor, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 20,
      right: 300,
      top: 20,
      bottom: 80,
      width: 280,
      height: 60,
      x: 20,
      y: 20,
      toJSON: () => ({}),
    }),
  });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });

  render(
    <TerminalSessionHoverCard
      shell={shell}
      displayName={shell.name}
      cardRef={{ current: anchor }}
      open
      suppressed={false}
      canvasZoom={canvasZoom}
      onOpenChange={vi.fn()}
    >
      <button type="button">Session</button>
    </TerminalSessionHoverCard>,
  );

  const hoverCard = screen.getByTestId(`terminal-session-hover-card-${shell.name}`);
  return shell.agent ? within(hoverCard).getByTestId(`terminal-session-agent-metadata-grid-${shell.name}`) : hoverCard;
}

describe("TerminalSessionHoverCard", () => {
  afterEach(() => {
    act(() => useCanvasTransform.setState({ zoom: 1 }));
    vi.useRealTimers();
  });

  it("shows confirmed terminal activity despite a recent metadata refresh", () => {
    vi.setSystemTime(new Date("2026-10-14T10:00:00Z"));
    renderHoverCard({ name: "idle-activity", updatedAt: "2026-10-14T09:58:00Z", activityAt: "2026-10-14T04:00:00Z", tabs: [] });
    expect(screen.getByText("Activity 6h ago").getAttribute("dateTime")).toBe("2026-10-14T04:00:00Z");
    expect(screen.queryByText("Updated 2m ago")).toBeNull();
  });

  it("does not invent recent activity for a legacy terminal", () => {
    renderHoverCard({ name: "legacy-activity", updatedAt: new Date().toISOString(), tabs: [] });
    expect(screen.getByText("Activity unknown").getAttribute("dateTime")).toBeNull();
  });

  it("uses the renderer's effective zoom instead of stale global canvas zoom", () => {
    useCanvasTransform.setState({ zoom: 0.5 });
    renderHoverCard({
      name: "claude-zoomed",
      status: "active",
      placement: "active",
      visualStatus: "idle",
      agent: "claude",
      model: "claude-opus-4-20250514",
      tabs: [],
    }, 1);

    const hoverCard = screen.getByTestId("terminal-session-hover-card-claude-zoomed");
    expect(hoverCard.style.transform).toContain("scale(1)");
    expect(hoverCard.style.transformOrigin).toBe("left top");
  });

  it("scales portal content with the renderer's effective canvas zoom", () => {
    renderHoverCard({
      name: "claude-canvas-zoomed",
      status: "active",
      placement: "active",
      visualStatus: "idle",
      agent: "claude",
      model: "claude-opus-4-20250514",
      tabs: [],
    }, 0.5);

    const hoverCard = screen.getByTestId("terminal-session-hover-card-claude-canvas-zoomed");
    expect(hoverCard.style.transform).toContain("scale(0.5)");
    expect(hoverCard.style.transformOrigin).toBe("left top");
  });

  it("gives model-only metadata the full available row", () => {
    const metadataGrid = renderHoverCard({
      name: "claude-model-only",
      status: "active",
      placement: "active",
      visualStatus: "idle",
      agent: "claude",
      model: "claude-opus-4-20250514",
      tabs: [],
    });

    expect(metadataGrid.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
  });

  it("gives strength-only metadata the full available row", () => {
    const metadataGrid = renderHoverCard({
      name: "codex-strength-only",
      status: "active",
      placement: "active",
      visualStatus: "waiting",
      agent: "codex",
      strength: "high",
      tabs: [],
    });

    expect(metadataGrid.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
  });

  it("keeps model and strength metadata in two columns", () => {
    const metadataGrid = renderHoverCard({
      name: "codex-model-strength",
      status: "active",
      placement: "active",
      visualStatus: "waiting",
      agent: "codex",
      model: "gpt-5.4",
      strength: "high",
      tabs: [],
    });

    expect(metadataGrid.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
  });
});
