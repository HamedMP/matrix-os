// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { columnDays, settle, setup } from "./helpers";

afterEach(cleanup);

function toolbarButton(name: string): HTMLElement {
  return within(screen.getByRole("toolbar", { name: "Calendar" })).getByRole("button", { name });
}

describe("calendar views", () => {
  it("opens on the week of today with Monday first and marks today", async () => {
    await setup();
    expect(columnDays()).toEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"]);
    expect(toolbarButton("Week").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Monday, November 23, 2026, today/ }).getAttribute("aria-current")).toBe("date");
    expect(screen.getAllByTestId("now-line")).toHaveLength(1);
  });

  it("switches between day, work week, week, month and agenda from the view switcher", async () => {
    await setup();
    fireEvent.click(toolbarButton("Day"));
    expect(columnDays()).toEqual(["2026-11-23"]);
    expect(toolbarButton("Day").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(toolbarButton("Work week"));
    expect(columnDays()).toEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"]);

    fireEvent.click(toolbarButton("Month"));
    await settle();
    expect(columnDays()).toEqual([]);
    const month = screen.getByRole("region", { name: "Month" });
    const cells = month.querySelectorAll("[data-day]");
    expect(cells.length % 7).toBe(0);
    expect(cells[0].getAttribute("data-day")).toBe("2026-10-26");
    expect(within(month).getByRole("button", { name: /^Standup,/ })).toBeTruthy();

    fireEvent.click(toolbarButton("Agenda"));
    await settle();
    const agenda = screen.getByRole("region", { name: "Agenda" });
    const days = within(agenda).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(days[0]).toMatch(/November 23/);
    expect(within(agenda).getByRole("button", { name: /Dinner/ })).toBeTruthy();
  });

  it("moves by whole views with previous, next and today, and follows keyboard shortcuts", async () => {
    await setup();
    fireEvent.click(toolbarButton("Next week"));
    await settle();
    expect(columnDays()[0]).toBe("2026-11-30");
    fireEvent.click(toolbarButton("Previous week"));
    fireEvent.click(toolbarButton("Previous week"));
    await settle();
    expect(columnDays()[0]).toBe("2026-11-16");
    fireEvent.click(toolbarButton("Today"));
    await settle();
    expect(columnDays()[0]).toBe("2026-11-23");

    fireEvent.keyDown(window, { key: "1" });
    expect(columnDays()).toEqual(["2026-11-23"]);
    fireEvent.keyDown(window, { key: "n" });
    await settle();
    expect(columnDays()).toEqual(["2026-11-24"]);
    fireEvent.keyDown(window, { key: "t" });
    fireEvent.keyDown(window, { key: "4" });
    await settle();
    expect(screen.getByRole("region", { name: "Month" })).toBeTruthy();
  });

  it("navigates from the mini month and from a day header", async () => {
    await setup();
    const navigator = screen.getByRole("group", { name: "Month navigator" });
    fireEvent.click(within(navigator).getByRole("button", { name: "Next month" }));
    fireEvent.click(within(navigator).getByRole("button", { name: "Thursday, December 10, 2026" }));
    await settle();
    expect(columnDays()[0]).toBe("2026-12-07");
    fireEvent.click(screen.getByRole("button", { name: /Friday, December 11, 2026\. Open day view/ }));
    await settle();
    expect(columnDays()).toEqual(["2026-12-11"]);
    expect(toolbarButton("Day").getAttribute("aria-pressed")).toBe("true");
  });

  it("shows an empty state with a retry when no calendar is connected", async () => {
    await setup({ accounts: false });
    expect(screen.getByRole("heading", { name: "Connect a calendar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  });

  it("opens the agent panel in the side slot and closes it again", async () => {
    await setup();
    fireEvent.click(toolbarButton("Agent"));
    const panel = screen.getByRole("complementary", { name: "Agent" });
    expect(await within(panel).findByRole("textbox", {}, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(toolbarButton("Agent"));
    expect(screen.queryByRole("complementary", { name: "Agent" })).toBeNull();
  });
});
