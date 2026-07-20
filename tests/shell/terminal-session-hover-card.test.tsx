// @vitest-environment jsdom

import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TerminalSessionHoverCard } from "../../shell/src/components/terminal/TerminalSessionHoverCard.js";
import type { ShellSessionSummary } from "../../shell/src/components/terminal/terminal-session-state.js";

function renderHoverCard(shell: ShellSessionSummary) {
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
      onOpenChange={vi.fn()}
    >
      <button type="button">Session</button>
    </TerminalSessionHoverCard>,
  );

  const hoverCard = screen.getByTestId(`terminal-session-hover-card-${shell.name}`);
  return within(hoverCard).getByText("Model").parentElement?.parentElement;
}

describe("TerminalSessionHoverCard", () => {
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

    expect(metadataGrid?.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
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

    expect(metadataGrid?.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
  });
});
