// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MatrixLoadingScreen } from "../../shell/src/components/MatrixLoadingScreen";

const ROOT = join(import.meta.dirname, "../..");

describe("MatrixLoadingScreen", () => {
  it("shows only the original animated gradient mark and landing-brand wordmark", () => {
    render(<MatrixLoadingScreen />);

    const heading = screen.getByRole("heading", { name: "Matrix OS" });
    expect(heading.style.fontFamily).toBe("var(--font-bricolage), 'Bricolage Grotesque', sans-serif");
    expect(heading.style.fontWeight).toBe("700");
    const mark = screen.getByRole("img", { name: "Matrix OS logo" });
    expect(mark.style.backgroundImage).toContain("linear-gradient");
    expect(mark.style.backgroundImage).toContain("rgb(196, 162, 101)");
    expect(mark.style.animation).toContain("onboard-shimmer 8s ease-in-out infinite");
    expect(mark.style.animation).toContain("onboard-glow 8s ease-in-out infinite");
    expect(screen.queryByText("Checking your workspace and preparing the right Matrix surface.")).toBeNull();
    expect(screen.queryByText("Loading Matrix")).toBeNull();
    expect(screen.getByRole("status").getAttribute("data-matrix-loading-screen")).toBe("true");
  });

  it("is the single loading surface used by journey and desktop hydration", () => {
    const bootSequence = readFileSync(join(ROOT, "shell/src/components/BootSequence.tsx"), "utf8");
    const desktop = readFileSync(join(ROOT, "shell/src/components/Desktop.tsx"), "utf8");
    const onboardingGate = readFileSync(join(ROOT, "shell/src/components/OnboardingGate.tsx"), "utf8");

    expect(bootSequence).toContain("<MatrixLoadingScreen />");
    expect(desktop).toContain("<MatrixLoadingScreen />");
    expect(onboardingGate).toContain("return <MatrixLoadingScreen />");
    expect(onboardingGate).not.toContain("Loading your Matrix computer…");
    expect(desktop).not.toContain("function MatrixFirstRunLoading");
    expect(desktop).not.toContain("isBootDesign(initialThemeStyle)");
  });
});
