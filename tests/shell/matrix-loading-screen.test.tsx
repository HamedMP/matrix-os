// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MatrixLoadingScreen } from "../../shell/src/components/MatrixLoadingScreen";

const ROOT = join(import.meta.dirname, "../..");

describe("MatrixLoadingScreen", () => {
  it("uses the shared Figma loading mark and motion without a second visible wordmark", () => {
    render(<MatrixLoadingScreen />);

    const heading = screen.getByRole("heading", { name: "Matrix OS" });
    expect(heading.className).toBe("matrix-boot-sr-only");
    const mark = screen.getByRole("img", { name: "Matrix OS logo" });
    expect(mark.className).toBe("matrix-boot-mark");
    expect(document.querySelector("style")?.textContent).toContain("matrix-boot-gradient 4s linear infinite");
    expect(document.querySelector("style")?.textContent).toContain("prefers-reduced-motion: reduce");
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

  it("shares the same loading presentation with Electron Desktop", () => {
    const app = readFileSync(join(ROOT, "desktop/src/renderer/src/App.tsx"), "utf8");
    expect(app).toContain('<MatrixBootScreen label="Connecting to your Matrix computer" />');
    expect(app).not.toContain("Connecting…");
  });
});
