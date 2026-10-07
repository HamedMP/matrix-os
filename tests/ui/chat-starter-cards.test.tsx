// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatStarterCards } from "../../packages/ui/src/chat/ChatStarterCards.js";
afterEach(cleanup);
it("offers the same four keyboard reachable drafting actions to both desktop clients", () => {
  const select = vi.fn();
  render(<ChatStarterCards onSelect={select} layout="two-by-two" />);
  expect(screen.getAllByRole("button")).toHaveLength(4);
  fireEvent.click(screen.getByRole("button", { name: "Explore and understand code" }));
  expect(select).toHaveBeenCalledWith("Explore and understand code");
});

it("owns layout styles without depending on a host Tailwind scan", () => {
  const { container } = render(<ChatStarterCards onSelect={vi.fn()} layout="two-by-two" />);
  const cards = container.querySelector('[data-slot="chat-starter-cards"]');
  expect(cards?.classList.contains("matrix-chat-starters")).toBe(true);
  expect(cards?.getAttribute("data-layout")).toBe("two-by-two");
  expect(cards?.getAttribute("data-density")).toBe("regular");
});
