// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DesktopSection } from "../../shell/src/components/settings/sections/DesktopSection.js";
import { Settings } from "../../shell/src/components/Settings.js";

describe("Desktop settings", () => {
  it("shows cloud-only policy, update channel, and Slay import guidance", () => {
    render(<DesktopSection />);

    expect(screen.getByText("Desktop")).toBeTruthy();
    expect(screen.getByText("Cloud-only coding agents")).toBeTruthy();
    expect(screen.getByText("Local agent execution cannot be enabled from desktop settings.")).toBeTruthy();
    expect(screen.getByText("Update channel")).toBeTruthy();
    expect(screen.getByText("Slay-style import guidance")).toBeTruthy();
  });

  it("wires Desktop into the main Settings navigation", () => {
    render(<Settings open onOpenChange={() => undefined} />);

    expect(screen.getByRole("button", { name: "Desktop" })).toBeTruthy();
  });
});
