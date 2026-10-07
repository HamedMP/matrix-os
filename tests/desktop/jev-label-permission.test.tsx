// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentRecipesPanel } from "../../packages/ui/src/chat-agents/AgentRecipesPanel.js";
afterEach(cleanup);
it("requires an explicit unchecked labeling choice and forwards it when building the recipe", () => {
  const create = vi.fn(async () => undefined);
  render(<AgentRecipesPanel onCreateJev={create} connections={[{ service: "gmail", account_label: "My Gmail", account_email: "me@example.test", status: "active" }]} />);
  const permission = screen.getByRole("checkbox", { name: "Allow this bot to add Jev labels to the selected Gmail account" });
  expect((permission as HTMLInputElement).checked).toBe(false);
  fireEvent.click(permission); fireEvent.click(screen.getByRole("button", { name: "Use Jev Inbox Triage" }));
  expect(create).toHaveBeenCalledWith("My Gmail", true);
});
