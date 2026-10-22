// @vitest-environment jsdom
import React, { type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { GetStartedUpdate } from "../../packages/contracts/src/index.js";
import { GetStartedGate, type GetStartedConnect, type GetStartedPort } from "../../packages/ui/src/get-started/index.js";

const AT = "2026-10-25T10:12:00.000Z";

function setup(connected: string[] = []) {
  const saves: GetStartedUpdate[] = [];
  const port: GetStartedPort = {
    load: vi.fn(async () => ({ status: "in_progress", updatedAt: AT, draft: { step: 4, name: "Sam", goals: ["business"], tools: [] } })),
    save: vi.fn(async (update: GetStartedUpdate) => {
      saves.push(update);
      return update.type === "complete" ? { status: "completed", completedAt: AT, answers: update.answers } : { status: "skipped", skippedAt: AT };
    }),
  };
  function Connector({ children }: { children: (connect: GetStartedConnect) => ReactNode }) {
    return <>{children({
      availableServices: new Set(), connectedServices: new Set(connected), failedServices: new Set(),
      logoUrls: new Map(), connectingService: null, unavailable: false, connect: vi.fn(),
    })}</>;
  }
  render(<GetStartedGate port={port} zIndex={1} connector={Connector}><div data-testid="widget" /></GetStartedGate>);
  return { saves };
}

afterEach(() => cleanup());

describe("Bots for you", () => {
  it("suggests bots for the goals, adds them on request, and creates nothing by itself", async () => {
    const { saves } = setup(["gmail"]);
    const list = await screen.findByRole("list", { name: "Bots for you" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByText("Needs Google Calendar")).toBeInTheDocument();
    expect(screen.getByText("Bots start with no access to your apps. You choose what each one can use.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Jev Inbox Triage" }));
    expect(screen.getByRole("button", { name: "Remove Jev Inbox Triage" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Enter your computer" }));
    await waitFor(() => expect(saves.at(-1)).toMatchObject({ type: "complete", answers: { bots: ["jev-inbox-triage"] } }));
  });

  it("sends no bots when none are added", async () => {
    const { saves } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Enter your computer" }));
    await waitFor(() => expect(saves.at(-1)?.type).toBe("complete"));
    expect(saves.at(-1)).not.toHaveProperty("answers.bots");
  });
});
