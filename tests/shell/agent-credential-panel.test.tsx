// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentCredentialPanel } from "../../shell/src/components/onboarding/AgentCredentialPanel.js";

describe("AgentCredentialPanel", () => {
  it("shows credential verification errors", () => {
    render(
      <AgentCredentialPanel
        status={null}
        error="Could not verify agent credential"
        onVerify={vi.fn()}
      />,
    );

    expect(screen.getByText("Could not verify agent credential")).toBeTruthy();
  });
});
