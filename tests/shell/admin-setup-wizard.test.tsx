// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdminSetupWizard } from "../../shell/src/components/onboarding/AdminSetupWizard.js";

describe("AdminSetupWizard", () => {
  it("hides resume action until a setup session exists", () => {
    const onResume = vi.fn();

    render(<AdminSetupWizard session={null} onResume={onResume} />);

    expect(screen.queryByRole("button", { name: /resume setup/i })).toBeNull();
  });

  it("resumes the existing setup session when present", () => {
    const onResume = vi.fn();

    render(
      <AdminSetupWizard
        session={{
          id: "setup.agent.claude",
          target: "agent:claude",
          status: "resumable",
          title: "Connect Claude",
          updatedAt: "2026-05-23T00:00:00.000Z",
        }}
        onResume={onResume}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /resume setup/i }));

    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
