// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AiUsagePanel } from "../../packages/ui/src/ai-usage/AiUsagePanel";
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);
it("opens the library listbox and changes the selected range using the keyboard", async () => {
  render(<AiUsagePanel />);
  const trigger = screen.getByRole("combobox", { name: "Date range" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(await screen.findByRole("listbox")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("option", { name: "Last 30 days" }), {
    key: "Enter",
  });
  expect(
    screen.getByRole("combobox", { name: "Date range" }).textContent,
  ).toContain("Last 30 days");
  expect(screen.queryByRole("listbox")).toBeNull();
});
