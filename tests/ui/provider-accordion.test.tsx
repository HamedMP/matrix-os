// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ProviderAccordion } from "../../packages/ui/src/agents-providers/ProviderAccordion";

afterEach(cleanup);
function Draft() {
  const [value, setValue] = useState("");
  return <input aria-label="Connection draft" value={value} onChange={event => setValue(event.target.value)} />;
}
it("lazily mounts connection state, preserves it across interrupted toggles, and makes collapsed controls inert", () => {
  const view = (expanded: boolean) => <><button id="details-trigger">Toggle</button><ProviderAccordion id="details" expanded={expanded}><Draft /></ProviderAccordion></>;
  const { rerender, container } = render(view(false));
  expect(screen.queryByLabelText("Connection draft")).not.toBeInTheDocument();
  const body = container.querySelector("#details")!;
  expect(body).toHaveAttribute("inert");
  expect(body).toHaveAttribute("aria-hidden", "true");
  rerender(view(true));
  const input = screen.getByRole("textbox", { name: "Connection draft" });
  fireEvent.change(input, { target: { value: "saved choice" } });
  expect(body).not.toHaveAttribute("hidden");
  expect(body).not.toHaveAttribute("inert");
  input.focus();
  rerender(view(false));
  expect(screen.getByRole("button", { name: "Toggle" })).toHaveFocus();
  expect(body).toHaveAttribute("inert");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(input).toBeInTheDocument();
  rerender(view(true));
  expect(screen.getByRole("textbox")).toBe(input);
  expect(input).toHaveValue("saved choice");
  expect(body).toHaveAttribute("data-expanded", "true");
});
