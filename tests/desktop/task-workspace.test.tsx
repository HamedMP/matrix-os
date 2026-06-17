// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskWorkspace from "../../desktop/src/renderer/src/features/workspace/TaskWorkspace";
import { useBoard, type Card } from "../../desktop/src/renderer/src/stores/board";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useGit } from "../../desktop/src/renderer/src/stores/git";
import { useSessions } from "../../desktop/src/renderer/src/stores/sessions";
import { useWorkspace } from "../../desktop/src/renderer/src/stores/workspace";

vi.mock("../../desktop/src/renderer/src/features/terminal/TerminalView", () => ({
  default: ({ sessionName }: { sessionName: string }) => <div>Terminal {sessionName}</div>,
}));

vi.mock("../../desktop/src/renderer/src/features/workspace/PanelStrip", () => ({
  default: ({ renderPanel }: { renderPanel: (panel: "terminal") => React.ReactNode }) => (
    <div>{renderPanel("terminal")}</div>
  ),
  PANEL_TITLES: {
    terminal: "Terminal",
    editor: "Editor",
    git: "Git",
    browser: "Files",
    artifacts: "Artifacts",
    processes: "Processes",
    timeline: "Timeline",
  },
}));

vi.mock("../../desktop/src/renderer/src/features/workspace/StartSessionControls", () => ({
  default: () => <button type="button">Start controls</button>,
}));

vi.mock("../../desktop/src/renderer/src/features/editor/EditorPanel", () => ({
  default: () => <div>Editor</div>,
}));

vi.mock("../../desktop/src/renderer/src/features/files/FilesPanel", () => ({
  default: () => <div>Files</div>,
}));

vi.mock("../../desktop/src/renderer/src/features/git/GitPanel", () => ({
  default: () => <div>Git</div>,
}));

vi.mock("../../desktop/src/renderer/src/features/workspace/ArtifactsPanel", () => ({
  default: () => <div>Artifacts</div>,
}));

vi.mock("../../desktop/src/renderer/src/features/workspace/ProcessesPanel", () => ({
  default: () => <div>Processes</div>,
}));

vi.mock("../../desktop/src/renderer/src/features/workspace/TimelinePanel", () => ({
  default: () => <div>Timeline</div>,
}));

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: "task_a",
    projectSlug: "proj",
    title: "Task A",
    description: "Fix it",
    status: "running",
    priority: "normal",
    order: 0,
    parentTaskId: null,
    linkedSessionId: "sess_live",
    linkedWorktreeId: null,
    previewIds: [],
    tags: [],
    updatedAt: null,
    revision: null,
    ...overrides,
  };
}

describe("TaskWorkspace", () => {
  beforeEach(() => {
    useConnection.setState({ api: {} as never });
    useBoard.setState({
      projects: [],
      activeProjectSlug: null,
      cardsByProject: { proj: [card()] },
      firstLoadByProject: {},
      refreshing: false,
      error: null,
    });
    useSessions.setState({
      sessions: [
        {
          name: "Task A",
          attachName: "matrix-agent-1",
          status: "active",
          source: "workspace",
          kind: "agent",
          agent: "codex",
          projectSlug: "proj",
          taskId: "task_a",
        },
      ],
      aliasMap: { sess_live: "matrix-agent-1" },
      load: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(true),
    });
    useGit.setState({
      worktrees: [],
      previews: [],
      loadAll: vi.fn().mockResolvedValue(undefined),
      loadPreviews: vi.fn().mockResolvedValue(undefined),
    });
    useWorkspace.setState(useWorkspace.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("hides header start controls while a live session is attached", () => {
    render(
      <Tooltip.Provider>
        <TaskWorkspace taskId="task_a" />
      </Tooltip.Provider>,
    );

    expect(screen.queryByRole("button", { name: /start controls/i })).toBeNull();
    expect(screen.getByText("Terminal matrix-agent-1")).toBeTruthy();
  });
});
