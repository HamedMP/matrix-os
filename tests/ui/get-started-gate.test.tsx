// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { GetStartedUpdate } from "../../packages/contracts/src/index.js";
import { GetStartedGate, type GetStartedPort } from "../../packages/ui/src/get-started/index.js";

const AT = "2026-10-25T10:12:00.000Z";

function makePort(initial: unknown, overrides: Partial<GetStartedPort> = {}) {
  const saves: GetStartedUpdate[] = [];
  const port: GetStartedPort = {
    load: vi.fn(async () => initial),
    save: vi.fn(async (update: GetStartedUpdate) => {
      saves.push(update);
      if (update.type === "complete") return { status: "completed", completedAt: AT, answers: update.answers };
      if (update.type === "skip") return { status: "skipped", skippedAt: AT };
      return { status: "in_progress", updatedAt: AT, draft: update.draft };
    }),
    ...overrides,
  };
  return { port, saves };
}

function renderGate(port: GetStartedPort) {
  return render(
    <GetStartedGate port={port} zIndex={690}>
      <div data-testid="desktop-widget">widget</div>
    </GetStartedGate>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("GetStartedGate", () => {
  it("holds the onboarding widget back while loading, then shows it for computers that are not eligible", async () => {
    let resolve!: (value: unknown) => void;
    const { port } = makePort(null, { load: vi.fn(() => new Promise((done) => { resolve = done; })) });
    renderGate(port);
    expect(screen.queryByTestId("desktop-widget")).not.toBeInTheDocument();
    await act(async () => resolve({ status: "not_eligible" }));
    expect(screen.getByTestId("desktop-widget")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([
    ["the gateway is unreachable", { load: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) }],
    ["the response is malformed", { load: vi.fn(async () => ({ status: "in_progress" })) }],
    ["the wizard is already finished", { load: vi.fn(async () => ({ status: "skipped", skippedAt: AT })) }],
  ])("fails closed to today's desktop when %s", async (_label, overrides) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderGate(makePort(null, overrides).port);
    expect(await screen.findByTestId("desktop-widget")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the wizard as a modal with no way to close it, kept out of session replay", async () => {
    renderGate(makePort({ status: "pending" }).port);
    const dialog = await screen.findByRole("dialog", { name: "What should we call you?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.closest(".ph-no-capture")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /close|minimi[sz]e/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("desktop-widget")).not.toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("walks the questions, saving a draft at each step, and finishes with the answers", async () => {
    const { port, saves } = makePort({ status: "pending" });
    renderGate(port);
    const name = await screen.findByPlaceholderText("Your first name");
    expect(name).toHaveFocus();
    fireEvent.change(name, { target: { value: "Sam" } });
    fireEvent.keyDown(name, { key: "Enter" });

    expect(await screen.findByRole("dialog", { name: "What will you use Matrix for?" })).toBeInTheDocument();
    await waitFor(() => expect(saves.at(-1)).toEqual({ type: "draft", draft: { step: 1, name: "Sam", goals: [], tools: [] } }));
    fireEvent.click(screen.getByRole("button", { name: "Write code with agents" }));
    expect(screen.getByRole("button", { name: "Write code with agents" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByText("Your coding tools")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));

    expect(await screen.findByRole("heading", { name: "All set, Sam." })).toBeInTheDocument();
    expect(screen.getByText("Write code with agents")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Enter your computer" }));

    expect(await screen.findByTestId("desktop-widget")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(saves.at(-1)).toEqual({ type: "complete", answers: { name: "Sam", goals: ["code"], tools: ["github"] } });
  });

  it("lets every question be skipped and goes back without losing answers", async () => {
    renderGate(makePort({ status: "pending" }).port);
    fireEvent.change(await screen.findByPlaceholderText("Your first name"), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    expect(await screen.findByText("Sounds fun")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(await screen.findByPlaceholderText("Your first name")).toHaveValue("Sam");
  });

  it("resumes a saved draft on the step it was left", async () => {
    renderGate(makePort({ status: "in_progress", updatedAt: AT, draft: { step: 2, name: "Sam", goals: ["build"], tools: [] } }).port);
    expect(await screen.findByText("First app idea")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Habit tracker" })).toHaveAttribute("aria-pressed", "false");
  });

  it("skips the whole setup from the first question", async () => {
    const { port, saves } = makePort({ status: "pending" });
    renderGate(port);
    fireEvent.click(await screen.findByRole("button", { name: "Skip setup" }));
    expect(await screen.findByTestId("desktop-widget")).toBeInTheDocument();
    expect(saves.at(-1)).toEqual({ type: "skip" });
  });

  it("keeps the answers and offers a retry when finishing fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let fail = true;
    const { port, saves } = makePort({ status: "in_progress", updatedAt: AT, draft: { step: 3, name: "Sam", goals: [], tools: [] } });
    const save = port.save;
    port.save = vi.fn(async (update: GetStartedUpdate) => {
      if (update.type === "complete" && fail) throw new Error("Postgres said no at /home/matrix");
      return save(update);
    });
    renderGate(port);
    fireEvent.click(await screen.findByRole("button", { name: "Enter your computer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't save your setup. Try again.");
    expect(screen.queryByText(/Postgres|\/home/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "All set, Sam." })).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Enter your computer" }));
    expect(await screen.findByTestId("desktop-widget")).toBeInTheDocument();
    expect(saves.at(-1)).toMatchObject({ type: "complete" });
  });

  it("keeps going when a draft save fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { port } = makePort({ status: "pending" }, { save: vi.fn(async () => { throw new Error("offline"); }) });
    renderGate(port);
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    expect(await screen.findByRole("dialog", { name: "What will you use Matrix for?" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
