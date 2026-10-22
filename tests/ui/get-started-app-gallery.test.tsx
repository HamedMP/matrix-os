// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { GetStartedUpdate } from "../../packages/contracts/src/index.js";
import { GetStartedGate, type GetStartedPort } from "../../packages/ui/src/get-started/index.js";

const AT = "2026-10-23T09:00:00.000Z";

function setup(draft: Record<string, unknown> = {}) {
  const saves: GetStartedUpdate[] = [];
  const port: GetStartedPort = {
    load: vi.fn(async () => ({ status: "in_progress", updatedAt: AT, draft: { step: 4, name: "Sam", goals: ["code"], tools: [], ...draft } })),
    save: vi.fn(async (update: GetStartedUpdate) => {
      saves.push(update);
      if (update.type === "complete") return { status: "completed", completedAt: AT, answers: update.answers };
      if (update.type === "draft") return { status: "in_progress", updatedAt: AT, draft: update.draft };
      return { status: "skipped", skippedAt: AT };
    }),
  };
  render(<GetStartedGate port={port} zIndex={1}><div /></GetStartedGate>);
  return { saves };
}

afterEach(() => cleanup());

describe("App Gallery step", () => {
  it("shows what you can build, for every goal", async () => {
    setup();
    expect(await screen.findByRole("heading", { name: "Build your own apps" })).toBeInTheDocument();
    const ideas = within(screen.getByRole("group", { name: "Build your own apps" })).getAllByRole("button");
    expect(ideas.map((idea) => idea.textContent)).toEqual([
      expect.stringContaining("Habit tracker"),
      expect.stringContaining("Client CRM"),
      expect.stringContaining("Budget planner"),
      expect.stringContaining("Recipe box"),
    ]);
    for (const idea of ideas) expect(idea.querySelector("svg")).not.toBeNull();
  });

  it("keeps the picked idea so Matrix offers to build it on arrival", async () => {
    const { saves } = setup();
    fireEvent.click(await screen.findByRole("button", { name: /Habit tracker/ }));
    expect(screen.getByRole("button", { name: /Habit tracker/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Finish" }));
    fireEvent.click(await screen.findByRole("button", { name: "Enter your computer" }));
    await waitFor(() => expect(saves.at(-1)).toMatchObject({ type: "complete", answers: { appIdea: "habit-tracker" } }));
  });

  it("shows an idea picked on the tools step as already chosen", async () => {
    setup({ goals: ["build"], appIdea: "recipe-box" });
    expect(await screen.findByRole("button", { name: /Recipe box/ })).toHaveAttribute("aria-pressed", "true");
  });
});
