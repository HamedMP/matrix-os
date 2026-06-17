// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GitPanel from "../../desktop/src/renderer/src/features/git/GitPanel";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useGit } from "../../desktop/src/renderer/src/stores/git";

describe("GitPanel", () => {
  beforeEach(() => {
    useConnection.setState({ api: null });
    useGit.setState({
      branches: [],
      prs: [],
      worktrees: [],
      previews: [],
      previewScope: null,
      refreshedAt: null,
      loading: false,
      error: "offline",
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("surfaces git load failures instead of rendering only empty counts", () => {
    render(<GitPanel projectSlug="matrix-os" />);

    expect(screen.getByRole("status").textContent).toMatch(/connection/i);
  });
});
