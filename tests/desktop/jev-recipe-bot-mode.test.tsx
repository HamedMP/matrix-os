// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentRecipesPanel } from "../../packages/ui/src/chat-agents/AgentRecipesPanel.js";

afterEach(cleanup);
const inbox = { recipeId: "jev-inbox-triage", version: "2026-09-28.1", name: "Inbox Triage",
  description: "Reads your inbox. It never changes your mail.", output: "Read-only proposals" };

it("keeps the bound Jev recipe discoverable when the generic bot catalog claims its ID", () => {
  const create = vi.fn().mockResolvedValue(undefined);
  const instantiate = vi.fn();
  render(<AgentRecipesPanel botRecipes={[inbox]} onInstantiateBot={instantiate} onOpenBotChat={vi.fn()}
    onCreateJev={create} connections={[{ service: "gmail", account_label: "My Gmail", account_email: "me@example.test", status: "active" }]} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search recipes" }), { target: { value: "Jev" } });
  const launch = screen.getByRole("button", { name: "Use Jev Inbox Triage" });
  expect((launch as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByRole("button", { name: "Use Inbox Triage" })).toBeNull();
  expect(screen.getByRole("checkbox")).toBeTruthy();
  fireEvent.click(launch);
  expect(create).toHaveBeenCalledWith("My Gmail", false);
  expect(instantiate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(launch);
  expect(create).toHaveBeenLastCalledWith("My Gmail", true);
});

it("keeps the generic inbox bot available on hosts without a bound Jev handoff", () => {
  render(<AgentRecipesPanel botRecipes={[inbox]} onInstantiateBot={vi.fn()} onOpenBotChat={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Use Inbox Triage" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Use Jev Inbox Triage" })).toBeNull();
});

it("keeps Jev discoverable before a bot catalog arrives and gates creation on Gmail", () => {
  render(<AgentRecipesPanel onCreateJev={vi.fn()} onInstantiateBot={vi.fn()} onOpenBotChat={vi.fn()} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search recipes" }), { target: { value: "Jev" } });
  expect((screen.getByRole("button", { name: "Use Jev Inbox Triage" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Connect Gmail in Services/)).toBeTruthy();
});
