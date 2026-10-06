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
