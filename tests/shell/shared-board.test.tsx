// @vitest-environment jsdom

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceApp } from "../../shell/src/components/workspace/WorkspaceApp.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("shared board UI", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/workspace/projects")) return json({ projects: [{ slug: "repo", name: "Repo" }] });
      if (url.includes("/api/projects/repo/board/members")) return json({ members: [{ userId: "user_2", role: "editor" }] });
      if (url.includes("/api/projects/repo/tickets")) return json({ tickets: [], nextCursor: null });
      if (url.includes("/api/projects/repo/tasks")) return json({ tasks: [] });
      if (url.includes("/api/reviews")) return json({ reviews: [] });
      if (url.includes("/api/projects/repo/worktrees")) return json({ worktrees: [] });
      if (url.includes("/api/projects/repo/previews")) return json({ previews: [] });
      if (url.includes("/api/workspace/events")) return json({ events: [] });
      if (url.includes("/api/projects/repo/workflow")) return json({ workflow: {}, codex: { status: "valid" } });
      if (url.includes("/api/sessions")) return json({ sessions: [] });
      return json({});
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows shared board teammates and roles in the workspace side panel", async () => {
    render(<WorkspaceApp initialProjectSlug="repo" />);

    await waitFor(() => expect(screen.getByText("Shared board")).toBeTruthy());
    expect(screen.getByText("user_2")).toBeTruthy();
    expect(screen.getByText("editor")).toBeTruthy();
  });
});
