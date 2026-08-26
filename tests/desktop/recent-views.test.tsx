// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import RecentViews from "../../desktop/src/renderer/src/features/mission-control/RecentViews";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useProjectView } from "../../desktop/src/renderer/src/stores/project-view";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";

describe("RecentViews", () => {
  beforeEach(() => {
    useBoard.setState({
      projects: [{ id: "project_1", slug: "matrix-os", name: "Matrix OS", kind: "folder" }],
    });
    useTabs.setState({
      tabs: [],
      activeTabId: null,
      recentFilter: "all",
      recentViews: [{ kind: "project", id: "matrix-os", label: "Matrix OS", visitedAt: Date.now() }],
    });
    useProjectView.setState({
      runtimeScope: null,
      entries: {
        "matrix-os": { view: "chats", selectedThreadId: "thread-old", touchedAt: Date.now() },
      },
    });
  });

  afterEach(cleanup);

  it("opens recent projects on the sessions overview instead of restoring a stale subview", () => {
    render(<RecentViews />);

    fireEvent.click(screen.getByRole("button", { name: "Open recent Matrix OS" }));

    expect(useProjectView.getState().viewFor("matrix-os")).toBe("overview");
    expect(useTabs.getState().tabs).toEqual([
      expect.objectContaining({ kind: "project", projectSlug: "matrix-os", title: "Matrix OS" }),
    ]);
  });

  it.each([
    [null, "chat"],
    ["project_1", "project"],
  ] as const)("opens a canonical Chat in its recorded scope %s", (projectId, expectedKind) => {
    useTabs.getState().recordRecentCanonicalChat("chat_1", "Canonical chat", projectId);
    render(<RecentViews />);

    fireEvent.click(screen.getByRole("button", { name: "Open recent Canonical chat" }));

    expect(useTabs.getState().tabs.at(-1)).toMatchObject(projectId === null
      ? { kind: expectedKind, chatId: "chat_1", chatView: "conversation" }
      : { kind: expectedKind, projectSlug: "matrix-os", chatId: "chat_1" });
  });
});
