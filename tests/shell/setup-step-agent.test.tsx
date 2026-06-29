// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock("@/lib/terminal-launch", () => ({ createTerminalLaunchPath: (id: string) => `__terminal__:${id}` }));

async function load() {
  vi.resetModules();
  return await import("../../shell/src/components/onboarding/steps/AgentStep.js");
}

describe("AgentStep", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    calls.opened = [];
  });
  afterEach(() => vi.restoreAllMocks());

  it("launches Codex CLI login when Connect is clicked", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          agents: [
            { id: "claude", available: true },
            { id: "codex", available: false },
          ],
        }),
        { status: 200 },
      ),
    );
    const { AgentStep } = await load();
    render(
      <AgentStep
        title="Connect a coding agent"
        status="active"
        expanded
        onOpenTerminal={(p) => calls.opened.push(p)}
        onChange={() => {}}
      />,
    );
    const connect = await screen.findByRole("button", { name: /connect/i });
    fireEvent.click(connect);
    expect(calls.opened.some((p) => p.includes("codex-login"))).toBe(true);
  });
});
