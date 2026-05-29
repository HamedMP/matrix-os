import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { SessionsView } from "../../src/cli/tui/views/SessionsView.js";
import { SessionDetailView } from "../../src/cli/tui/views/SessionDetailView.js";
import { ShellRuntimeViews } from "../../src/cli/tui/views/ShellRuntimeViews.js";
import { SessionForms } from "../../src/cli/tui/views/SessionForms.js";

describe("session cockpit views", () => {
  const sessions = [
    { id: "shell:main", kind: "shell" as const, name: "main", status: "running", context: "~/project", attention: "ready" },
    { id: "sess_abc123", kind: "agent" as const, name: "Fix tests", status: "running", projectSlug: "repo", agent: "codex", attention: "busy" },
  ];

  it("renders unified shell and coding session rows", () => {
    const output = renderToString(<SessionsView sessions={sessions} selectedIndex={1} noColor />);

    expect(output).toContain("Matrix Sessions");
    expect(output).toContain("main");
    expect(output).toContain("Fix tests");
    expect(output).toContain("codex");
  });

  it("renders session details without exposing zellij as the primary label", () => {
    const output = renderToString(<SessionDetailView session={sessions[1]} noColor />);

    expect(output).toContain("Fix tests");
    expect(output).toContain("repo");
    expect(output).toContain("observe");
    expect(output).not.toContain("zellij attach");
  });

  it("renders shell runtime tabs, panes, layouts, and create forms", () => {
    expect(renderToString(<ShellRuntimeViews tabs={[{ index: 0, name: "editor" }]} panes={[{ id: "pane-1" }]} layouts={["dev"]} noColor />)).toContain("editor");
    expect(renderToString(<SessionForms mode="create-shell" noColor />)).toContain("Create shell session");
    expect(renderToString(<SessionForms mode="remote-run" noColor />)).toContain("Remote run");
  });
});
