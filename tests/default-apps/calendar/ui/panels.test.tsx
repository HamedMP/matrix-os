// @vitest-environment jsdom
/**
 * Side panels follow the shell's close rules: the trigger toggles them and
 * Escape closes the topmost one. Escape inside a dialog or popover closes
 * only that, and Escape never sends or saves anything.
 */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { eventButton, settle, setup } from "./helpers";

afterEach(cleanup);

function toolbarButton(name: string): HTMLElement {
  return within(screen.getByRole("toolbar", { name: "Calendar" })).getByRole("button", { name });
}

describe("calendar side panels", () => {
  it("closes the agent panel with Escape, even from its text box", async () => {
    await setup();
    fireEvent.click(toolbarButton("Agent"));
    const panel = screen.getByRole("complementary", { name: "Agent" });
    const box = await within(panel).findByRole("textbox", {}, { timeout: 5000 });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Agent" })).toBeNull();
    expect(toolbarButton("Agent").getAttribute("aria-pressed")).toBe("false");
  });

  it("closes the composer with Escape without saving, before the agent panel behind it", async () => {
    const { provider } = await setup();
    fireEvent.click(toolbarButton("Agent"));
    fireEvent.click(toolbarButton("New event"));
    const title = within(screen.getByRole("form", { name: "New event" })).getByLabelText("Title");
    fireEvent.change(title, { target: { value: "Unsent" } });
    fireEvent.keyDown(title, { key: "Escape" });
    await settle();
    expect(screen.queryByRole("form", { name: "New event" })).toBeNull();
    expect(provider.callsTo("createEvent")).toHaveLength(0);
    // The agent panel was open behind the composer and comes back.
    expect(screen.getByRole("complementary", { name: "Agent" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Agent" })).toBeNull();
  });

  it("lets Escape close only the event popover when one is open", async () => {
    await setup();
    fireEvent.click(toolbarButton("New event"));
    fireEvent.click(eventButton("Standup"));
    const popover = screen.getByRole("dialog", { name: "Standup" });
    fireEvent.keyDown(popover, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Standup" })).toBeNull();
    expect(screen.getByRole("form", { name: "New event" })).toBeTruthy();
  });
});
