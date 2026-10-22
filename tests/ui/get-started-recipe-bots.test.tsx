// @vitest-environment jsdom
import React, { type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { GetStartedUpdate } from "../../packages/contracts/src/index.js";
import { GetStartedGate, type GetStartedConnect, type GetStartedPort } from "../../packages/ui/src/get-started/index.js";

const AT = "2026-10-25T10:12:00.000Z";

function setup(connected: string[] = [], options: { available?: string[]; draft?: Record<string, unknown> } = {}) {
  const saves: GetStartedUpdate[] = [];
  const port: GetStartedPort = {
    load: vi.fn(async () => ({ status: "in_progress", updatedAt: AT, draft: { step: 5, name: "Sam", goals: ["business"], tools: [], ...options.draft } })),
    save: vi.fn(async (update: GetStartedUpdate) => {
      saves.push(update);
      if (update.type === "complete") return { status: "completed", completedAt: AT, answers: update.answers };
      if (update.type === "draft") return { status: "in_progress", updatedAt: AT, draft: update.draft };
      return { status: "skipped", skippedAt: AT };
    }),
  };
  const connect = vi.fn();
  function Connector({ children }: { children: (connect: GetStartedConnect) => ReactNode }) {
    return <>{children({
      availableServices: new Set(options.available ?? []), connectedServices: new Set(connected), failedServices: new Set(),
      logoUrls: new Map(), connectingService: null, unavailable: false, connect,
    })}</>;
  }
  render(<GetStartedGate port={port} zIndex={1} connector={Connector}><div data-testid="widget" /></GetStartedGate>);
  return { saves, connect };
}

afterEach(() => cleanup());

describe("Meet your bots", () => {
  it("gives bots their own screen with avatars and how they work", async () => {
    setup(["gmail"]);
    expect(await screen.findByRole("heading", { name: "Meet your bots" })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Bots for you" });
    const bots = within(list).getAllByRole("listitem");
    expect(bots).toHaveLength(3);
    for (const bot of bots) expect(bot.querySelector("[data-recipe-rabbit]")).not.toBeNull();
    expect(within(list).getByText("Needs Google Calendar")).toBeInTheDocument();
    expect(screen.getByText("Start with no access to your apps. You choose what each one can use.")).toBeInTheDocument();
  });

  it("adds bots on request, lists them in the summary, and creates nothing by itself", async () => {
    const { saves } = setup(["gmail"]);
    fireEvent.click(await screen.findByRole("button", { name: "Add Jev Inbox Triage" }));
    expect(screen.getByRole("button", { name: "Remove Jev Inbox Triage" })).toHaveAttribute("aria-pressed", "true");
    expect(saves.some((update) => update.type === "complete")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect((await screen.findByText("Your bots")).nextElementSibling).toHaveTextContent("Jev Inbox Triage");
    fireEvent.click(screen.getByRole("button", { name: "Enter your computer" }));
    await waitFor(() => expect(saves.at(-1)).toMatchObject({ type: "complete", answers: { bots: ["jev-inbox-triage"] } }));
  });

  it("sends no bots when none are added or the screen is skipped", async () => {
    const { saves } = setup(["gmail"]);
    fireEvent.click(await screen.findByRole("button", { name: "Add Jev Inbox Triage" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(await screen.findByText("Your bots")).toBeInTheDocument();
    expect(screen.getByText("Your bots").nextElementSibling).toHaveTextContent(/^None yet$/);
    fireEvent.click(screen.getByRole("button", { name: "Enter your computer" }));
    await waitFor(() => expect(saves.at(-1)?.type).toBe("complete"));
    expect(saves.at(-1)).not.toHaveProperty("answers.bots");
  });

  it("offers the missing app's sign-in right in the bot row", async () => {
    const { connect } = setup(["gmail"], { available: ["google_calendar", "gmail"] });
    const bots = await screen.findByRole("list", { name: "Bots for you" });
    fireEvent.click(within(bots).getByRole("button", { name: "Connect Google Calendar" }));
    expect(connect).toHaveBeenCalledWith("google_calendar");
  });

  it("saves added bots right away, so a reload keeps them", async () => {
    const { saves } = setup(["gmail"]);
    fireEvent.click(await screen.findByRole("button", { name: "Add Jev Inbox Triage" }));
    await waitFor(() => expect(saves.at(-1)).toMatchObject({ type: "draft", draft: { step: 5, bots: ["jev-inbox-triage"] } }));
    cleanup();
    setup(["gmail"], { draft: { bots: ["jev-inbox-triage"] } });
    expect(await screen.findByRole("button", { name: "Remove Jev Inbox Triage" })).toHaveAttribute("aria-pressed", "true");
  });
});
