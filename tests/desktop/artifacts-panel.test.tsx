// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ArtifactsPanel, { canOpenPreviewUrl } from "../../desktop/src/renderer/src/features/workspace/ArtifactsPanel";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useGit } from "../../desktop/src/renderer/src/stores/git";

afterEach(() => {
  cleanup();
});

describe("artifacts preview URLs", () => {
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

    render(<ArtifactsPanel projectSlug="matrix-os" taskId="task-1" />);

    expect(screen.getByText("Couldn't load artifacts")).toBeTruthy();
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

    render(<ArtifactsPanel projectSlug="matrix-os" taskId="task-1" />);

    expect(screen.queryByText("Couldn't load artifacts")).toBeNull();
    expect(screen.getByText("No previews")).toBeTruthy();
  });
});
