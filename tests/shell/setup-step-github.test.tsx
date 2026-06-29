// @vitest-environment jsdom
import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/terminal-launch", () => ({
  createTerminalLaunchPath: (action: string) => `__terminal__:setup-${action}-abc123`,
}));

async function load() {
  vi.resetModules();
  vi.mock("@/lib/terminal-launch", () => ({
    createTerminalLaunchPath: (action: string) => `__terminal__:setup-${action}-abc123`,
  }));
  return await import("../../shell/src/components/onboarding/steps/GithubStep.js");
}

describe("GithubStep", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("case 1: expanded + not authenticated → clicking 'Authorize GitHub' calls onOpenTerminal with github-ssh-login path", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
      if (String(url).includes("/api/github/status")) {
        return new Response(
          JSON.stringify({ installed: true, authenticated: false, user: null }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    });

    const { GithubStep } = await load();
    const onOpenTerminal = vi.fn();

    render(
      <GithubStep
        title="Connect GitHub"
        status="active"
        expanded={true}
        onOpenTerminal={onOpenTerminal}
      />,
    );

    // Wait for the fetch to settle (no authenticated user means expanded body stays visible)
    await waitFor(() => expect(screen.getByText("Authorize GitHub")).toBeTruthy());

    fireEvent.click(screen.getByText("Authorize GitHub"));

    expect(onOpenTerminal).toHaveBeenCalledWith(
      expect.stringContaining("github-ssh-login"),
    );
  });

  it("case 2: authenticated user → renders @hamedmp", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
      if (String(url).includes("/api/github/status")) {
        return new Response(
          JSON.stringify({ installed: true, authenticated: true, user: "hamedmp" }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    });

    const { GithubStep } = await load();

    render(
      <GithubStep
        title="Connect GitHub"
        status="done"
        expanded={false}
        onOpenTerminal={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("@hamedmp")).toBeTruthy());
  });
});
