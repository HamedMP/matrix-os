// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopActivityInbox } from "../../packages/ui/src/desktop-agent-inbox";
import * as uiExports from "../../packages/ui/src/index";
import type { TerminalTabFacts } from "../../packages/ui/src/terminal-agents/attention";
const WS = "tws_00000000000000000000000000000001";
const TAB = "tt_00000000000000000000000000000001";
const NOW = Date.parse("2026-07-06T00:10:00.000Z");
const agentThread = (id: string, overrides: Record<string, unknown> = {}) => ({
 id, providerId: "codex", title: "Coding agent run", status: "running", attention: "none",
 createdAt: "2026-07-06T00:00:00.000Z", updatedAt: "2026-07-06T00:07:00.000Z", ...overrides,
});
const summary = (label = "Notes app build completed", extra: Record<string, unknown> = {}) => ({
 runtime: { id: "rt_primary", label: "Main", status: "available" }, capabilities: [], providers: [],
 projects: { items: [], hasMore: false, limit: 20 }, activeThreads: { items: [], hasMore: false, limit: 20 },
 attentionThreads: { items: [], hasMore: false, limit: 20 },
 recentActivity: { items: [{ id: "evt_notes", kind: "thread", label, occurredAt: "2026-07-06T00:03:00.000Z" }], hasMore: false, limit: 20 },
 limits: { maxPromptBytes: 16384, maxAttachmentCount: 8, maxTerminalInputBytes: 8192, maxListItems: 20 }, serverTime: "2026-07-06T00:03:00.000Z",
 ...extra,
});
const herdrTab = (overrides: Partial<TerminalTabFacts> = {}): Record<string, TerminalTabFacts> => ({
 [`${WS}:${TAB}`]: { ref: { workspaceId: WS, tabId: TAB }, name: "Herdr parity", cwd: "", state: "live", agentStatus: "blocked", statusMessage: "Allow git push?", statusAt: "2026-07-06T00:09:00.000Z", ...overrides },
});
const agentSummary = () => summary("Notes app build completed", {
 activeThreads: { items: [agentThread("thread_run", { title: "Fix composer warning" })], hasMore: false, limit: 20 },
 attentionThreads: { items: [agentThread("thread_approval", { status: "waiting_for_approval", attention: "approval_required", title: "Approve deploy" })], hasMore: false, limit: 20 },
 recentThreads: { items: [agentThread("thread_done", { status: "completed", title: "Release notes" })], hasMore: false, limit: 10 },
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
  expect(screen.queryByText("No agent activity yet.")).toBeNull();
 });
 it("keeps the shared package exports for both renderers", () => {
  expect(uiExports.DesktopActivityInbox).toBe(DesktopActivityInbox);
  expect(typeof uiExports.DesktopInboxMenu).toBe("function");
 });
 it("shows agents grouped by status with filter counts and a needs-you badge", async () => {
  render(<DesktopActivityInbox scope="main" load={async () => agentSummary()} terminalTabs={herdrTab()} now={() => NOW} />);
  await screen.findByRole("button", { name: "Inbox, 2 agents need you" });
  fireEvent.click(screen.getByRole("button", { name: "Inbox, 2 agents need you" }));
  await screen.findByRole("heading", { name: "Agents" });
  expect(screen.getByRole("button", { name: "All 5" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Needs you 2" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Running 1" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Done 2" })).toBeTruthy();
  expect(screen.getByText("Herdr parity")).toBeTruthy();
  expect(screen.getByText("Allow git push?")).toBeTruthy();
  expect(screen.getByText("Approval")).toBeTruthy();
  expect(screen.queryByText("Coding agent run")).toBeNull();
  expect(screen.queryByText("Task needs attention")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Running 1" }));
  expect(screen.getByText("Fix composer warning")).toBeTruthy();
  expect(screen.queryByText("Herdr parity")).toBeNull();
  expect(screen.queryByText("Release notes")).toBeNull();
 });
 it("opens the exact thread or terminal tab a row came from", async () => {
  const onOpenTask = vi.fn();
  const onOpenTerminal = vi.fn();
  render(<DesktopActivityInbox scope="main" load={async () => agentSummary()} terminalTabs={herdrTab()} onOpenTask={onOpenTask} onOpenTerminal={onOpenTerminal} now={() => NOW} />);
  fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Approve deploy/ }));
  expect(onOpenTask).toHaveBeenCalledWith("thread_approval");
  fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Herdr parity/ }));
  expect(onOpenTerminal).toHaveBeenCalledWith(`${WS}:${TAB}`);
 });
 it("falls back to a thread's own terminal tab when the renderer cannot open chats", async () => {
  const onOpenTerminal = vi.fn();
  const load = async () => summary("Notes app build completed", {
   activeThreads: { items: [agentThread("thread_tab", { title: "Terminal run", terminalRef: { workspaceId: WS, tabId: TAB } })], hasMore: false, limit: 20 },
  });
  render(<DesktopActivityInbox scope="main" load={load} onOpenTerminal={onOpenTerminal} now={() => NOW} />);
  fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Terminal run/ }));
  expect(onOpenTerminal).toHaveBeenCalledWith(`${WS}:${TAB}`);
 });
 it("does not offer a button for a row the renderer cannot open", async () => {
  render(<DesktopActivityInbox scope="main" load={async () => agentSummary()} onOpenTerminal={vi.fn()} now={() => NOW} />);
  fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
  await screen.findByText("Approve deploy");
  expect(screen.queryByRole("button", { name: /Approve deploy/ })).toBeNull();
 });
 it("shows an empty state per filter", async () => {
  render(<DesktopActivityInbox scope="main" load={async () => summary("Notes app build completed")} now={() => NOW} />);
  fireEvent.click(screen.getByRole("button", { name: "Inbox" }));
  fireEvent.click(await screen.findByRole("button", { name: "Needs you 0" }));
  const empty = screen.getByTestId("agent-inbox-empty");
  expect(empty.querySelector("svg")).not.toBeNull();
  expect(empty).toHaveTextContent("Nothing needs you right now.");
  expect(empty).toHaveTextContent("Approvals and questions from your agents show up here.");
  expect(empty).toHaveTextContent("Start an agent from Chat or Terminal.");
 });
 it("keeps live terminal agents visible with an inline notice when the summary fails", async () => {
  // The load runs on mount and again on open; both fail before the retry succeeds.
  const load = vi.fn().mockRejectedValueOnce(new Error("private-path")).mockRejectedValueOnce(new Error("private-path")).mockResolvedValue(agentSummary());
  render(<DesktopActivityInbox scope="main" load={load} terminalTabs={herdrTab()} onOpenTerminal={vi.fn()} now={() => NOW} />);
  fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Agent runs could not load. Showing terminal agents.");
  expect(screen.getByRole("button", { name: /Herdr parity/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Needs you 1" })).toBeTruthy();
  expect(screen.queryByText("Notifications are unavailable.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry notifications" }));
  await screen.findByText("Approve deploy");
  expect(screen.queryByRole("alert")).toBeNull();
 });
});
