// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopActivityInbox } from "../../packages/ui/src/desktop-top-bar";
const summary = (label = "Notes app build completed") => ({
 runtime: { id: "rt_primary", label: "Main", status: "available" }, capabilities: [], providers: [],
 projects: { items: [], hasMore: false, limit: 20 }, activeThreads: { items: [], hasMore: false, limit: 20 },
 attentionThreads: { items: [], hasMore: false, limit: 20 },
 recentActivity: { items: [{ id: "evt_notes", kind: "thread", label, occurredAt: "2026-07-06T00:03:00.000Z" }], hasMore: false, limit: 20 },
 limits: { maxPromptBytes: 16384, maxAttachmentCount: 8, maxTerminalInputBytes: 8192, maxListItems: 20 }, serverTime: "2026-07-06T00:03:00.000Z",
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("shared app and task inbox", () => {
 it("renders actual current activity instead of an unconditional empty message", async () => {
  render(<DesktopActivityInbox scope="main" load={async () => summary()} />);
  fireEvent.click(screen.getByRole("button", { name: "Inbox" }));
  await screen.findByText("Notes app build completed");
  expect(screen.queryByText("No new notifications.")).toBeNull();
 });
 it("shows a recoverable generic error and never claims empty on a rejected snapshot", async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error("private-path")).mockRejectedValueOnce(new Error("private-path")).mockResolvedValue(summary());
  render(<DesktopActivityInbox scope="main" load={load} />);
  fireEvent.click(screen.getByRole("button", { name: "Inbox" }));
  await screen.findByText("Notifications are unavailable.");
  expect(screen.queryByText("private-path")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry notifications" }));
  await screen.findByText("Notes app build completed");
 });
 it.each([
  ["schema", async () => ({ owner: "private-owner-bytes" }), "ZodError"],
  ["transport", async () => { const error = new Error("private-path"); error.name = "private-owner-name"; throw error; }, "Error"],
  ["non-error", async () => { throw { owner: "private-owner-bytes" }; }, "non-error"],
 ] as const)("logs only a bounded error class for %s failures", async (_kind, load, category) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  render(<DesktopActivityInbox scope="main" load={load} />);
  fireEvent.click(screen.getByRole("button", { name: "Inbox" }));
  await screen.findByText("Notifications are unavailable.");
  expect(warn).toHaveBeenCalledWith("[desktop-inbox] load failed:", category);
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-/);
 });
 it("isolates an old computer snapshot that resolves after a switch", async () => {
  let resolve!: (value: unknown) => void;
  const old = () => new Promise(r => { resolve = r; });
  const current = async () => summary("Current app completed");
  const view = render(<DesktopActivityInbox scope="old" load={old} />);
  fireEvent.click(screen.getByRole("button", { name: "Inbox" }));
  view.rerender(<DesktopActivityInbox scope="new" load={current} />);
  fireEvent.click(screen.getByRole("button", { name: "Inbox" }));
  await screen.findByText("Current app completed");
  resolve(summary("Old owner activity"));
  await waitFor(() => expect(screen.queryByText("Old owner activity")).toBeNull());
 });
 it("does not treat invalid snapshot data as a verified empty inbox", async () => {
  render(<DesktopActivityInbox scope="main" load={async () => ({ recentActivity: [] })} />);
  fireEvent.click(screen.getByRole("button", { name: "Inbox" }));
  await screen.findByText("Notifications are unavailable.");
  expect(screen.queryByText("No app or task notifications yet.")).toBeNull();
 });
});
