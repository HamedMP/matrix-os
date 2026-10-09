// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatAgentsPanel } from "../../../packages/ui/src/chat-agents/ChatAgentsEntry.js";
import type { BotClient } from "../../../packages/ui/src/chat-agents/bots/client.js";
import { clientFixture } from "../../desktop/chat-agents-fixture.js";

afterEach(cleanup);
const jev = { recipeId: "jev-inbox-triage", version: "2026-10-06.1", name: "Jev Inbox Triage",
  description: "Classifies Inbox with Jev", output: "Verified labels" };

it("shows a loading state instead of legacy Hermes Jev while native recipes are pending", async () => {
  const recipes = vi.fn(() => new Promise<never>(() => {}));
  const client = { ...clientFixture(), bots: { recipes } as unknown as BotClient };
  render(<ChatAgentsPanel client={client} view="recipes" onClose={vi.fn()} onOpenBotChat={vi.fn()} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search recipes" }), { target: { value: "jev" } });
  expect(await screen.findByText("Loading bot recipes…")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Use Jev Inbox Triage" })).toBeNull();
  expect(screen.queryByText("No recipes match that search.")).toBeNull();
});

it("reports native catalog failure safely and retries without offering the legacy recipe", async () => {
  const recipes = vi.fn().mockRejectedValueOnce(new Error("postgres at /home/matrix failed"))
    .mockResolvedValueOnce([jev]);
  const client = { ...clientFixture(), bots: { recipes } as unknown as BotClient };
  const create = client.create;
  render(<ChatAgentsPanel client={client} view="recipes" onClose={vi.fn()} onOpenBotChat={vi.fn()} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search recipes" }), { target: { value: "jev" } });
  expect(await screen.findByText("Bot recipes are temporarily unavailable.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Use Jev Inbox Triage" })).toBeNull();
  expect(screen.queryByText(/postgres|\/home\/matrix/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry bot recipes" }));
  expect(await screen.findByRole("button", { name: "Use Jev Inbox Triage" })).toBeTruthy();
  await waitFor(() => expect(recipes).toHaveBeenCalledTimes(2));
  expect(create).not.toHaveBeenCalled();
});

it("does not retain another computer's recipes while its replacement catalog is loading", async () => {
  const first = { ...clientFixture(), bots: { recipes: vi.fn(async () => [jev]) } as unknown as BotClient };
  const second = { ...clientFixture(), bots: { recipes: vi.fn(() => new Promise<never>(() => {})) } as unknown as BotClient };
  const view = render(<ChatAgentsPanel client={first} view="recipes" onClose={vi.fn()} onOpenBotChat={vi.fn()} />);
  await screen.findByRole("button", { name: "Use Jev Inbox Triage" });
  view.rerender(<ChatAgentsPanel client={second} view="recipes" onClose={vi.fn()} onOpenBotChat={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Use Jev Inbox Triage" })).toBeNull();
  expect(await screen.findByText("Loading bot recipes…")).toBeTruthy();
});
