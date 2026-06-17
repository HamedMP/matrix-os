// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BoardCard from "../../desktop/src/renderer/src/features/board/BoardCard";
import type { Card } from "../../desktop/src/renderer/src/stores/board";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useGit } from "../../desktop/src/renderer/src/stores/git";
import { useSessions } from "../../desktop/src/renderer/src/stores/sessions";

vi.mock("../../desktop/src/renderer/src/design/primitives", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../desktop/src/renderer/src/design/primitives")>();
  return {
    ...actual,
    ContextMenu: ({
      items,
      children,
    }: {
      items: Array<{ label: string; onSelect: () => void }>;
      children: React.ReactNode;
    }) => (
      <div>
        {children}
        <div data-testid="board-card-menu">
          {items.map((item) => (
            <button key={item.label} type="button" onClick={item.onSelect}>
              {item.label}
            </button>
          ))}
        </div>
      </div>
    ),
  };
});

const baseCard: Card = {
  id: "task-1",
  projectSlug: "project",
  title: "Ship desktop",
  description: "",
  status: "todo",
  priority: "normal",
  order: 1,
  parentTaskId: null,
  linkedSessionId: "session-1",
  linkedWorktreeId: null,
  previewIds: [],
  tags: [],
  updatedAt: null,
  revision: null,
};

describe("BoardCard", () => {
  beforeEach(() => {
    useConnection.setState({ api: null });
    useGit.setState({ worktrees: [], previews: [] });
    useSessions.setState({ sessions: [], aliasMap: {} });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("hides start-agent menu actions while a linked session is live", () => {
    useSessions.setState({
      aliasMap: { "session-1": "operator-session" },
      sessions: [
        {
          name: "operator-session",
          attachName: "operator-session",
          status: "active",
          source: "workspace",
        },
      ],
    });

    render(<BoardCard card={baseCard} />);

    expect(screen.queryByText("Start Claude")).toBeNull();
    expect(screen.queryByText("Start Codex")).toBeNull();
  });

  it("shows start-agent menu actions when no linked session is live", () => {
    useSessions.setState({
      aliasMap: { "session-1": "operator-session" },
      sessions: [
        {
          name: "operator-session",
          attachName: "operator-session",
          status: "exited",
          source: "workspace",
        },
      ],
    });

    render(<BoardCard card={baseCard} />);

    expect(screen.getByText("Start Claude")).toBeTruthy();
    expect(screen.getByText("Start Codex")).toBeTruthy();
  });
});
