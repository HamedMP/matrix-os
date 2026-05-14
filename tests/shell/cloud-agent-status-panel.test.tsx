// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CloudAgentStatusPanel } from "../../shell/src/components/workspace/CloudAgentStatusPanel.js";

describe("CloudAgentStatusPanel", () => {
  it("summarizes cloud agents without showing local runtime controls", () => {
    render(<CloudAgentStatusPanel sessions={[
      { id: "sess_1", agent: "codex", status: "running", cloudRuntime: { status: "running" }, taskId: "ticket_1" },
      { id: "sess_2", agent: "codex", status: "blocked", cloudRuntime: { status: "attention" }, taskId: "ticket_2" },
    ]} />);

    expect(screen.getByText("Cloud agents")).toBeTruthy();
    expect(screen.getByText("1 running")).toBeTruthy();
    expect(screen.getByText("1 needs attention")).toBeTruthy();
    expect(screen.queryByText(/local runtime/i)).toBeNull();
  });

  it("uses one effective runtime status per session", () => {
    render(<CloudAgentStatusPanel sessions={[
      { id: "sess_1", agent: "codex", status: "running", runtime: { status: "running" }, cloudRuntime: { status: "failed" } },
      { id: "sess_2", agent: "codex", status: "queued", runtime: { status: "running" } },
    ]} />);

    expect(screen.getByText("1 running")).toBeTruthy();
    expect(screen.getByText("1 needs attention")).toBeTruthy();
  });
});
