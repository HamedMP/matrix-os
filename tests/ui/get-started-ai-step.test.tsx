// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { GET_STARTED_FALLBACK_BOT_NAMES, type GetStartedBotNamesRequest, type GetStartedUpdate } from "../../packages/contracts/src/index.js";
import { GetStartedGate, type GetStartedPort } from "../../packages/ui/src/get-started/index.js";

const AT = "2026-10-25T10:12:00.000Z";

function port(suggestBotNames?: GetStartedPort["suggestBotNames"]) {
  const saves: GetStartedUpdate[] = [];
  const value: GetStartedPort = {
    ...(suggestBotNames ? { suggestBotNames } : {}),
    load: vi.fn(async () => ({ status: "in_progress", updatedAt: AT, draft: { step: 4, name: "Sam", goals: ["code"], tools: [] } })),
    save: vi.fn(async (update: GetStartedUpdate) => {
      saves.push(update);
      return update.type === "complete" ? { status: "completed", completedAt: AT, answers: update.answers } : { status: "in_progress", updatedAt: AT, draft: update.type === "draft" ? update.draft : {} };
    }),
  };
  return { port: value, saves };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const MODEL_NAMES = [
  [{ name: "Luna", emoji: "🌙" }, { name: "Ledger", emoji: "📒" }, { name: "Pixel", emoji: "👾" }, { name: "Orbit", emoji: "🪐" }, { name: "Kite", emoji: "🪁" }],
  [{ name: "Juniper", emoji: "🌲" }, { name: "Echo", emoji: "📣" }, { name: "Comet", emoji: "☄️" }, { name: "Maple", emoji: "🍁" }, { name: "Quill", emoji: "🪶" }],
];

function suggestionRow() {
  return screen.getByRole("group", { name: "Suggested names" });
}

function chipNames() {
  return within(suggestionRow()).getAllByRole("button").map((button) => button.textContent?.trim());
}

describe("Make your AI yours", () => {
  it("names the AI, previews its style, shows what it writes, and saves it", async () => {
    const { port: gatePort, saves } = port();
    render(<GetStartedGate port={gatePort} zIndex={1} />);
    expect(await screen.findByRole("dialog", { name: "Name your main bot" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Atlas" }));
    fireEvent.click(screen.getByRole("button", { name: "Straight shooter" }));
    expect(screen.getByText("Here's the fix. One warning: that change will lock the table.")).toBeInTheDocument();
    expect(screen.getByText("Always asks before doing anything outside Matrix.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(screen.getByRole("button", { name: "Short" }));
    fireEvent.click(screen.getByRole("button", { name: "Never" }));
    expect(screen.getByText("Here's the fix.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "See what this writes" }));
    expect(screen.getByText(/Your name is Atlas\. You are Sam's personal Matrix assistant\./)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("heading", { name: "Build your own apps" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Finish" }));
    expect(await screen.findByText("Atlas · Straight shooter")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Enter your computer" }));
    await waitFor(() => expect(saves.at(-1)).toMatchObject({
      type: "complete",
      answers: { name: "Sam", bot: { name: "Atlas", personality: "straight-shooter", length: "short", emoji: "never" } },
    }));
  });

  it("keeps the AI as Matrix when the step is skipped", async () => {
    const { port: gatePort, saves } = port();
    render(<GetStartedGate port={gatePort} zIndex={1} />);
    fireEvent.click(await screen.findByRole("button", { name: "Atlas" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(await screen.findByRole("heading", { name: "Build your own apps" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Finish" }));
    expect((await screen.findByText("Your AI")).nextElementSibling).toHaveTextContent(/^Matrix$/);
    fireEvent.click(screen.getByRole("button", { name: "Enter your computer" }));
    await waitFor(() => expect(saves.at(-1)?.type).toBe("complete"));
    expect(saves.at(-1)).not.toHaveProperty("answers.bot");
  });

  it("accepts a typed name", async () => {
    const { port: gatePort } = port();
    render(<GetStartedGate port={gatePort} zIndex={1} />);
    fireEvent.change(await screen.findByLabelText("AI name"), { target: { value: "Juno" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("heading", { name: "Build your own apps" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Finish" }));
    expect(await screen.findByText(/^Juno · /)).toBeInTheDocument();
  });

  it("shows the name that will be saved when the typed one is blank", async () => {
    const { port: gatePort, saves } = port();
    render(<GetStartedGate port={gatePort} zIndex={1} />);
    fireEvent.change(await screen.findByLabelText("AI name"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("heading", { name: "Build your own apps" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Finish" }));
    expect((await screen.findByText("Your AI")).nextElementSibling).toHaveTextContent(/^Matrix · /);
    fireEvent.click(screen.getByRole("button", { name: "Enter your computer" }));
    await waitFor(() => expect(saves.at(-1)).toMatchObject({ type: "complete", answers: { bot: { name: "Matrix" } } }));
  });

  it("keeps a typed name that starts with a suggestion", async () => {
    const { port: gatePort } = port();
    render(<GetStartedGate port={gatePort} zIndex={1} />);
    const input = await screen.findByLabelText("AI name");
    fireEvent.change(input, { target: { value: "Atlas" } });
    expect(input).toHaveValue("Atlas");
    fireEvent.change(input, { target: { value: "AtlasPrime" } });
    expect(input).toHaveValue("AtlasPrime");
  });

  it("blocks names the Matrix Bot cannot use, with a reason", async () => {
    const { port: gatePort } = port();
    render(<GetStartedGate port={gatePort} zIndex={1} />);
    fireEvent.change(await screen.findByLabelText("AI name"), { target: { value: "Task-master" } });
    expect(screen.getByRole("alert")).toHaveTextContent("That name can't be used. Try another.");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("AI name"), { target: { value: "Taskmaster" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  it("says which choices the sample reply reflects", async () => {
    const { port: gatePort } = port();
    render(<GetStartedGate port={gatePort} zIndex={1} />);
    expect(await screen.findByText(/Language, tone and humour apply in real chats\./)).toBeInTheDocument();
  });
});

describe("Suggested bot names", () => {
  it("shows five names from the small model for the owner's goals and personality, and refresh asks for new ones", async () => {
    const requests: GetStartedBotNamesRequest[] = [];
    const suggest = vi.fn(async (request: GetStartedBotNamesRequest) => {
      requests.push(request);
      return { names: MODEL_NAMES[requests.length - 1] };
    });
    const { port: gatePort, saves } = port(suggest);
    render(<GetStartedGate port={gatePort} zIndex={1} />);
    expect(await screen.findByRole("button", { name: "Luna" })).toBeInTheDocument();
    expect(chipNames()).toEqual(["🌙 Luna", "📒 Ledger", "👾 Pixel", "🪐 Orbit", "🪁 Kite"]);
    expect(requests[0]).toEqual({ goals: ["code"], personality: "friendly-helper", exclude: [] });

    fireEvent.click(screen.getByRole("button", { name: "Straight shooter" }));
    fireEvent.click(screen.getByRole("button", { name: "Suggest new names" }));
    expect(await screen.findByRole("button", { name: "Juniper" })).toBeInTheDocument();
    expect(requests[1]).toEqual({ goals: ["code"], personality: "straight-shooter", exclude: ["Luna", "Ledger", "Pixel", "Orbit", "Kite"] });

    fireEvent.click(screen.getByRole("button", { name: "Comet" }));
    expect(screen.getByRole("button", { name: "Comet" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("AI name")).toHaveValue("Comet");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Finish" }));
    fireEvent.click(await screen.findByRole("button", { name: "Enter your computer" }));
    // The emoji is decoration; only the name is saved.
    await waitFor(() => expect(saves.at(-1)).toMatchObject({ type: "complete", answers: { bot: { name: "Comet" } } }));
  });

  it("holds five placeholders while the first names load, and keeps the current names during a refresh", async () => {
    let resolve!: (value: unknown) => void;
    const suggest = vi.fn(() => new Promise((done) => { resolve = done; }));
    render(<GetStartedGate port={port(suggest).port} zIndex={1} />);
    await screen.findByRole("dialog", { name: "Name your main bot" });
    await waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
    expect(suggestionRow()).toHaveAttribute("aria-busy", "true");
    expect(suggestionRow().querySelectorAll(".mxo-chip--placeholder")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Suggest new names" })).toBeDisabled();
    await act(async () => resolve({ names: MODEL_NAMES[0] }));
    expect(suggestionRow()).toHaveAttribute("aria-busy", "false");
    fireEvent.click(screen.getByRole("button", { name: "Suggest new names" }));
    expect(chipNames()).toEqual(["🌙 Luna", "📒 Ledger", "👾 Pixel", "🪐 Orbit", "🪁 Kite"]);
    expect(suggestionRow()).toHaveAttribute("aria-busy", "true");
    await act(async () => resolve({ names: MODEL_NAMES[1] }));
    expect(chipNames()[0]).toBe("🌲 Juniper");
  });

  it("uses the built-in names when suggestions fail, answer badly, or are unavailable on this surface", async () => {
    const builtIn = GET_STARTED_FALLBACK_BOT_NAMES.slice(0, 5).map((item) => `${item.emoji} ${item.name}`);
    for (const suggest of [
      vi.fn(async () => { throw new Error("503"); }),
      vi.fn(async () => ({ names: MODEL_NAMES[0]!.slice(0, 3) })),
      undefined,
    ]) {
      render(<GetStartedGate port={port(suggest).port} zIndex={1} />);
      await screen.findByRole("dialog", { name: "Name your main bot" });
      await waitFor(() => expect(chipNames()).toEqual(builtIn));
      // Refresh pages through the built-in list.
      fireEvent.click(screen.getByRole("button", { name: "Suggest new names" }));
      await waitFor(() => expect(chipNames()).toEqual(GET_STARTED_FALLBACK_BOT_NAMES.slice(5, 10).map((item) => `${item.emoji} ${item.name}`)));
      cleanup();
    }
  });

  it("shows every built-in name before repeating any, however many refreshes", async () => {
    render(<GetStartedGate port={port().port} zIndex={1} />);
    await screen.findByRole("dialog", { name: "Name your main bot" });
    const seen = [...chipNames()];
    const pages = Math.ceil(GET_STARTED_FALLBACK_BOT_NAMES.length / 5);
    for (let page = 1; page < pages; page += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Suggest new names" }));
      seen.push(...chipNames());
    }
    expect(new Set(seen).size).toBe(GET_STARTED_FALLBACK_BOT_NAMES.length);
    fireEvent.click(screen.getByRole("button", { name: "Suggest new names" }));
    expect(chipNames()).toEqual(seen.slice(0, 5));
  });

  it("stops waiting after 12 seconds and ignores a late answer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let resolve!: (value: unknown) => void;
    const suggest = vi.fn((_request: GetStartedBotNamesRequest, signal: AbortSignal) => new Promise((done) => { resolve = done; void signal; }));
    render(<GetStartedGate port={port(suggest).port} zIndex={1} />);
    await screen.findByRole("dialog", { name: "Name your main bot" });
    await waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
    const signal = suggest.mock.calls[0]![1];
    await act(async () => { vi.advanceTimersByTime(12_000); });
    expect(chipNames()).toEqual(GET_STARTED_FALLBACK_BOT_NAMES.slice(0, 5).map((item) => `${item.emoji} ${item.name}`));
    expect(signal.aborted).toBe(true);
    await act(async () => resolve({ names: MODEL_NAMES[0] }));
    expect(screen.queryByRole("button", { name: "Luna" })).not.toBeInTheDocument();
  });
});
