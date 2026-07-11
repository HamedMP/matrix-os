// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentConversationInspector,
  type AgentConversationInspectorTab,
} from "../../desktop/src/renderer/src/features/coding-agents/AgentConversationInspector";

afterEach(cleanup);

function renderInspector(defaultTab: AgentConversationInspectorTab = "changes") {
  return render(
    <AgentConversationInspector
      defaultTab={defaultTab}
      counts={{ changes: 2, terminal: 1, preview: 3, activity: 4 }}
      toolbar={<button type="button">New chat</button>}
      composer={<div>Composer</div>}
      changes={<div>Changed files</div>}
      terminal={<div>Matrix shell</div>}
      preview={<div>Preview sessions</div>}
      activity={<div>Workspace activity</div>}
    />,
  );
}

describe("AgentConversationInspector", () => {
  it("shows one contextual surface at a time with live counts", () => {
    renderInspector();

    const tablist = screen.getByRole("tablist", { name: "Conversation tools" });
    expect(tablist).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Changes 2" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Changed files")).toBeTruthy();
    expect(screen.queryByText("Matrix shell")).toBeNull();
    expect(screen.queryByText("Preview sessions")).toBeNull();
    expect(screen.queryByText("Workspace activity")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Terminal 1" }));

    expect(screen.getByRole("tab", { name: "Terminal 1" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Matrix shell")).toBeTruthy();
    expect(screen.queryByText("Changed files")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Preview 3" }));
    expect(screen.getByText("Preview sessions")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Activity 4" }));
    expect(screen.getByText("Workspace activity")).toBeTruthy();
  });

  it("keeps the toolbar and optional composer visible while switching surfaces", () => {
    renderInspector("terminal");

    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();
    expect(screen.getByText("Composer")).toBeTruthy();
    expect(screen.getByText("Matrix shell")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Changes 2" }));

    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();
    expect(screen.getByText("Composer")).toBeTruthy();
    expect(screen.getByText("Changed files")).toBeTruthy();
  });

  it("supports keyboard arrow navigation without losing the selected pane", () => {
    renderInspector();

    const changes = screen.getByRole("tab", { name: "Changes 2" });
    changes.focus();
    fireEvent.keyDown(changes, { key: "ArrowRight" });

    const terminal = screen.getByRole("tab", { name: "Terminal 1" });
    expect(document.activeElement).toBe(terminal);
    expect(terminal.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Matrix shell")).toBeTruthy();

    fireEvent.keyDown(terminal, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Activity 4" }));
    expect(screen.getByText("Workspace activity")).toBeTruthy();
  });
});
