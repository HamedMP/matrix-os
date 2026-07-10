// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentWorkspaceSection,
  AgentWorkspaceStack,
} from "../../desktop/src/renderer/src/features/coding-agents/AgentWorkspaceSection";

describe("AgentWorkspaceSection", () => {
  afterEach(cleanup);

  it("keeps stacked workspace content at its intrinsic height", () => {
    render(
      <AgentWorkspaceSection title="New Run">
        <div style={{ height: 480 }}>Composer</div>
      </AgentWorkspaceSection>,
    );

    const section = screen.getByRole("heading", { name: "New Run" }).closest("section");
    expect(section?.className).not.toContain("min-h-0");
  });

  it("uses normal-flow stacking so tall sections cannot overlap implicit grid rows", () => {
    render(
      <AgentWorkspaceStack>
        <AgentWorkspaceSection title="New Run">Composer</AgentWorkspaceSection>
        <AgentWorkspaceSection title="Notifications">Preferences</AgentWorkspaceSection>
      </AgentWorkspaceStack>,
    );

    const stack = screen.getByTestId("agent-workspace-stack");
    expect(stack.className).toContain("space-y-4");
    expect(stack.className.split(" ")).not.toContain("grid");
  });
});
