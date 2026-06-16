// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ArtifactsPanel, {
  canOpenPreviewUrl,
} from "../../desktop/src/renderer/src/features/workspace/ArtifactsPanel";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useGit } from "../../desktop/src/renderer/src/stores/git";

describe("ArtifactsPanel", () => {
  beforeEach(() => {
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: null,
    });
    useGit.setState({
      previews: [
        {
          id: "preview_task_a",
          projectSlug: "proj",
          taskId: "task_a",
          label: "Task preview",
          url: "https://preview.example.com",
          lastStatus: "ok",
        },
      ],
      previewScope: { projectSlug: "proj", taskId: null },
      error: null,
      previewError: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders task previews even after a project-wide preview load changes scope", () => {
    render(
      <Tooltip.Provider>
        <ArtifactsPanel projectSlug="proj" taskId="task_a" />
      </Tooltip.Provider>,
    );

    expect(screen.getByText("Task preview")).toBeTruthy();
    expect(screen.queryByText("No previews")).toBeNull();
  });

  it("allows only secure HTTP preview links", () => {
    expect(canOpenPreviewUrl("http://127.0.0.1:5173")).toBe(false);
    expect(canOpenPreviewUrl("https://preview.example.com")).toBe(true);
  });

  it("rejects non-web preview links", () => {
    expect(canOpenPreviewUrl("javascript:alert(1)")).toBe(false);
    expect(canOpenPreviewUrl("file:///tmp/preview.html")).toBe(false);
    expect(canOpenPreviewUrl("/relative-preview")).toBe(false);
    expect(canOpenPreviewUrl(null)).toBe(false);
  });

  it("surfaces preview load failures instead of showing an empty artifact list", () => {
    useConnection.setState({ api: null });
    useGit.setState({
      previews: [],
      previewScope: { projectSlug: "matrix-os", taskId: "task-1" },
      error: null,
      previewError: "timeout",
    });

    render(
      <Tooltip.Provider>
        <ArtifactsPanel projectSlug="matrix-os" taskId="task-1" />
      </Tooltip.Provider>,
    );

    expect(screen.getByText("Couldn't load previews")).toBeTruthy();
    expect(screen.queryByText("No previews")).toBeNull();
  });

  it("does not show list load failures as artifact failures", () => {
    useConnection.setState({ api: null });
    useGit.setState({
      previews: [],
      previewScope: { projectSlug: "matrix-os", taskId: "task-1" },
      error: "timeout",
      previewError: null,
    });

    render(
      <Tooltip.Provider>
        <ArtifactsPanel projectSlug="matrix-os" taskId="task-1" />
      </Tooltip.Provider>,
    );

    expect(screen.queryByText("Couldn't load previews")).toBeNull();
    expect(screen.getByText("No previews")).toBeTruthy();
  });
});
