// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentConversationInspector,
  type AgentConversationInspectorTab,
} from "../../desktop/src/renderer/src/features/coding-agents/AgentConversationInspector";

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

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

function controlledPanel(tabName: string): HTMLElement {
  const tab = screen.getByRole("tab", { name: new RegExp(`^${tabName}\\b`) });
  const panelId = tab.getAttribute("aria-controls");
  const panel = panelId ? document.getElementById(panelId) : null;
  if (!panel) throw new Error(`Missing panel for ${tabName}`);
  return panel;
}

describe("AgentConversationInspector", () => {
  it("shows one contextual surface at a time with live counts", () => {
    renderInspector();

    const tablist = screen.getByRole("tablist", { name: "Conversation tools" });
    expect(tablist).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Changes 2" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Changed files")).toBeTruthy();
    expect(controlledPanel("Changes").hidden).toBe(false);
    expect(controlledPanel("Terminal").hidden).toBe(true);
    expect(controlledPanel("Preview").hidden).toBe(true);
    expect(controlledPanel("Activity").hidden).toBe(true);

    fireEvent.click(screen.getByRole("tab", { name: "Terminal 1" }));

    expect(screen.getByRole("tab", { name: "Terminal 1" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Matrix shell")).toBeTruthy();
    expect(controlledPanel("Terminal").hidden).toBe(false);
    expect(controlledPanel("Changes").hidden).toBe(true);

    fireEvent.click(screen.getByRole("tab", { name: "Preview 3" }));
    expect(screen.getByText("Preview sessions")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Activity 4" }));
    expect(screen.getByText("Workspace activity")).toBeTruthy();
  });

  it("preserves an unsaved file draft while another surface is open", () => {
    render(
      <AgentConversationInspector
        defaultTab="changes"
        counts={{ changes: 1, terminal: 1, preview: 0, activity: 0 }}
        toolbar={<div>Tools</div>}
        changes={<input aria-label="Unsaved file draft" defaultValue="" />}
        terminal={<div>Matrix shell</div>}
        preview={<div>No previews</div>}
        activity={<div>No activity</div>}
      />,
    );

    const draft = screen.getByLabelText("Unsaved file draft") as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "keep this edit" } });
    fireEvent.click(screen.getByRole("tab", { name: "Terminal 1" }));
    fireEvent.click(screen.getByRole("tab", { name: "Changes 1" }));

    expect((screen.getByLabelText("Unsaved file draft") as HTMLInputElement).value).toBe("keep this edit");
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

  it("reveals Changes when an external review action requests focus", () => {
    const counts = { changes: 2, terminal: 1, preview: 3, activity: 4 };
    const view = render(
      <AgentConversationInspector
        defaultTab="changes"
        changesFocusRequestId={0}
        counts={counts}
        toolbar={<div>Tools</div>}
        changes={<div>Changed files</div>}
        terminal={<div>Matrix shell</div>}
        preview={<div>Preview sessions</div>}
        activity={<div>Workspace activity</div>}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Activity 4" }));

    view.rerender(
      <AgentConversationInspector
        defaultTab="changes"
        changesFocusRequestId={1}
        counts={counts}
        toolbar={<div>Tools</div>}
        changes={<div>Changed files</div>}
        terminal={<div>Matrix shell</div>}
        preview={<div>Preview sessions</div>}
        activity={<div>Workspace activity</div>}
      />,
    );

    expect(screen.getByRole("tab", { name: "Changes 2" }).getAttribute("aria-selected")).toBe("true");
    expect(controlledPanel("Changes").hidden).toBe(false);
  });

  it("ignores an already-consumed review-focus request when mounting", () => {
    const onChangesFocusConsumed = vi.fn();
    render(
      <AgentConversationInspector
        defaultTab="terminal"
        changesFocusRequestId={3}
        changesFocusConsumedId={3}
        onChangesFocusConsumed={onChangesFocusConsumed}
        counts={{ changes: 2, terminal: 1, preview: 3, activity: 4 }}
        toolbar={<div>Tools</div>}
        changes={<div>Changed files</div>}
        terminal={<div>Matrix shell</div>}
        preview={<div>Preview sessions</div>}
        activity={<div>Workspace activity</div>}
      />,
    );

    expect(screen.getByRole("tab", { name: /^Terminal\b/ }).getAttribute("aria-selected")).toBe("true");
    expect(controlledPanel("Terminal").hidden).toBe(false);
    expect(onChangesFocusConsumed).not.toHaveBeenCalled();
  });

  it("honors an unconsumed focus request that arrived before mount", () => {
    // The command palette selects a review and THEN opens the Agents tab, so
    // the inspector can mount after the signal was raised.
    const onChangesFocusConsumed = vi.fn();
    render(
      <AgentConversationInspector
        defaultTab="terminal"
        changesFocusRequestId={3}
        changesFocusConsumedId={0}
        onChangesFocusConsumed={onChangesFocusConsumed}
        counts={{ changes: 2, terminal: 1, preview: 3, activity: 4 }}
        toolbar={<div>Tools</div>}
        changes={<div>Changed files</div>}
        terminal={<div>Matrix shell</div>}
        preview={<div>Preview sessions</div>}
        activity={<div>Workspace activity</div>}
      />,
    );

    expect(screen.getByRole("tab", { name: /^Changes\b/ }).getAttribute("aria-selected")).toBe("true");
    expect(onChangesFocusConsumed).toHaveBeenCalledWith(3);
  });

  it("does not react when the focus signal resets to zero", () => {
    const counts = { changes: 2, terminal: 1, preview: 3, activity: 4 };
    const onChangesFocusConsumed = vi.fn();
    const inspector = (requestId: number, consumedId: number) => (
      <AgentConversationInspector
        defaultTab="terminal"
        changesFocusRequestId={requestId}
        changesFocusConsumedId={consumedId}
        onChangesFocusConsumed={onChangesFocusConsumed}
        counts={counts}
        toolbar={<div>Tools</div>}
        changes={<div>Changed files</div>}
        terminal={<div>Matrix shell</div>}
        preview={<div>Preview sessions</div>}
        activity={<div>Workspace activity</div>}
      />
    );
    const view = render(inspector(0, 0));
    view.rerender(inspector(2, 0));
    expect(screen.getByRole("tab", { name: /^Changes\b/ }).getAttribute("aria-selected")).toBe("true");
    expect(onChangesFocusConsumed).toHaveBeenCalledWith(2);

    fireEvent.click(screen.getByRole("tab", { name: /^Terminal\b/ }));
    // A runtime switch resets the one-shot counter; that is not a focus request.
    view.rerender(inspector(0, 0));

    expect(screen.getByRole("tab", { name: /^Terminal\b/ }).getAttribute("aria-selected")).toBe("true");
    expect(controlledPanel("Terminal").hidden).toBe(false);
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

  it("stays icon-first below the label width threshold, with full names on the tabs", () => {
    // jsdom has no ResizeObserver, so the tablist never crosses the label
    // threshold and keeps its compact icon + badge anatomy.
    renderInspector();

    const tablist = screen.getByRole("tablist", { name: "Conversation tools" });
    // No visible label text and no truncation styling anywhere in the bar —
    // tabs never ellipsis; the accessible name carries the full label.
    for (const label of ["Changes", "Terminal", "Preview", "Activity"]) {
      expect(within(tablist).queryByText(label)).toBeNull();
    }
    expect(tablist.querySelector(".truncate")).toBeNull();
    const changes = screen.getByRole("tab", { name: "Changes 2" });
    expect(changes.querySelector("svg")).not.toBeNull();
    // Count badges keep their existing pill anatomy.
    expect(within(changes).getByText("2")).toBeTruthy();
  });

  it("shows full labels only once the tablist is wide enough", () => {
    let observerCallback: ResizeObserverCallback | null = null;
    class CapturingResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        observerCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
    renderInspector();

    const tablist = screen.getByRole("tablist", { name: "Conversation tools" });
    expect(within(tablist).queryByText("Terminal")).toBeNull();

    // Four tabs × 96px = 384px threshold; a wide inspector earns labels.
    act(() => {
      observerCallback?.([{ contentRect: { width: 600 } } as ResizeObserverEntry], {} as ResizeObserver);
    });
    expect(within(tablist).getByText("Terminal")).toBeTruthy();
    expect(within(tablist).getByText("Changes")).toBeTruthy();

    // Shrinking back below the threshold hides them again.
    act(() => {
      observerCallback?.([{ contentRect: { width: 200 } } as ResizeObserverEntry], {} as ResizeObserver);
    });
    expect(within(tablist).queryByText("Terminal")).toBeNull();
  });

  it("renders only the contextual surfaces supplied by the project model", () => {
    render(
      <AgentConversationInspector
        defaultTab="files"
        tabs={["files", "terminal", "activity"]}
        counts={{ changes: 0, files: undefined, terminal: 1, preview: 0, activity: 2 }}
        toolbar={<div>Tools</div>}
        changes={<div>Reviews</div>}
        files={<div>Matrix Home files</div>}
        terminal={<div>Linked terminal</div>}
        preview={<div>Project preview</div>}
        activity={<div>Project activity</div>}
      />,
    );

    expect(screen.queryByRole("tab", { name: /^Changes\b/ })).toBeNull();
    expect(screen.queryByRole("tab", { name: /^Preview\b/ })).toBeNull();
    expect(screen.getByRole("tab", { name: /^Files\b/ })).toBeTruthy();
    expect(screen.getByText("Matrix Home files")).toBeTruthy();
  });
});
