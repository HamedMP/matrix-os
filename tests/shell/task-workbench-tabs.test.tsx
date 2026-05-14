// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createTaskWorkbenchStore } from "../../shell/src/stores/task-workbench.js";
import { TaskWorkbenchTabs } from "../../shell/src/components/workspace/TaskWorkbenchTabs.js";

describe("Task workbench tabs", () => {
  it("keeps tab state serializable and restores active ticket context", () => {
    const store = createTaskWorkbenchStore();
    store.openTab({ id: "ticket_1", kind: "ticket", title: "Ticket 1", projectSlug: "repo" });
    store.openTab({ id: "session_1", kind: "session", title: "Agent", projectSlug: "repo" });
    store.activate("ticket_1");

    expect(JSON.parse(JSON.stringify(store.snapshot()))).toMatchObject({ activeTabId: "ticket_1" });

    render(<TaskWorkbenchTabs tabs={store.snapshot().tabs} activeTabId="ticket_1" onActivate={store.activate} />);
    fireEvent.click(screen.getByText("Agent"));

    expect(store.snapshot().activeTabId).toBe("session_1");
  });
});
