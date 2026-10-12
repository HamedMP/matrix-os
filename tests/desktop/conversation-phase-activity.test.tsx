// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationActivityGroup } from "../../desktop/src/renderer/src/components/conversation/activity";
import type { ConversationActivityPresentation } from "../../desktop/src/renderer/src/components/conversation/presentation";

afterEach(cleanup);
const preview = `Current model: ${"long-model-name-".repeat(12)}`;
const phase: ConversationActivityPresentation = {
  id: "model", kind: "phase", state: "running", label: "Working", preview, previewKind: "text",
};

it("retains full model identity and progress while completing a phase", () => {
  const callbacks = { copyText: vi.fn() };
  const view = render(<ConversationActivityGroup activities={[phase]} callbacks={callbacks} />);
  const model = screen.getByRole("button", { name: `Working: ${preview}` });
  expect(screen.getByTitle(preview)).toHaveTextContent(preview);
  expect(model.querySelector(".animate-spin")).toBeInTheDocument();
  expect(model).toHaveAttribute("aria-expanded", "false");
  view.rerender(<ConversationActivityGroup activities={[{ ...phase, state: "completed", label: "Worked" }]} callbacks={callbacks} />);
  expect(screen.getByRole("button", { name: `Worked: ${preview}` })).toBeInTheDocument();
  expect(screen.getByTitle(preview)).toHaveTextContent(preview);
  expect(view.container.querySelector(".animate-spin")).not.toBeInTheDocument();
});

it("preserves earlier tool expansion and copy alongside the current model", async () => {
  const copyText = vi.fn(async () => {});
  const tool: ConversationActivityPresentation = {
    id: "tool", kind: "command", state: "completed", label: "Ran command",
    preview: "git status --short", previewKind: "command", detail: "Working tree clean", copyText: "git status --short",
  };
  render(<ConversationActivityGroup activities={[tool, phase]} callbacks={{ copyText }} />);
  expect(screen.queryByRole("button", { name: "Ran command: git status --short" })).not.toBeInTheDocument();
  const previous = screen.getByRole("button", { name: "1 previous activity" });
  fireEvent.click(previous);
  expect(previous).toHaveAttribute("aria-expanded", "true");
  const command = screen.getByRole("button", { name: "Ran command: git status --short" });
  fireEvent.click(command);
  expect(command).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("Working tree clean")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith("git status --short"));
  expect(screen.getByRole("button", { name: `Working: ${preview}` })).toBeInTheDocument();
  fireEvent.click(previous);
  expect(screen.queryByText("Working tree clean")).not.toBeInTheDocument();
});
