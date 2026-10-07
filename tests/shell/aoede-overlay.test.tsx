// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AoedeCard } from "@matrix-os/contracts";
import { AoedeOverlay } from "../../shell/src/aoede/AoedeOverlay";

const session = vi.hoisted(() => ({
  status: "active", connected: true, captions: [], cards: [] as AoedeCard[],
  captioning: false, deciding: [] as string[], actionError: false,
  audioRef: { current: null }, inputStream: () => null,
  start: vi.fn(), stop: vi.fn(), clearRecovery: vi.fn(), approval: vi.fn(), cancel: vi.fn(),
}));
vi.mock("../../shell/src/aoede/useAoedeSession", () => ({ useAoedeSession: () => session }));
const running: AoedeCard = { id: "task-one", chatId: "chat-one", runId: "run-one", title: "Build a weather app", status: "running" };
const approval: AoedeCard = { ...running, id: "task-two", status: "approval", approval: {
  approvalId: "approval-one", title: "Read project files", description: "Read the weather project's source files.",
  risk: "low", allowedDecisions: ["approve_once", "deny"],
} };
function overlay() { return render(<AoedeOverlay active onUi={() => ({ status: "failed" })} />); }
beforeEach(() => { session.cards = []; session.deciding = []; session.connected = true; session.status = "active"; vi.clearAllMocks(); });
afterEach(cleanup);

it("keeps ordinary tasks behind a quiet count disclosure with exact cancellation", () => {
  session.cards = [running, { ...running, id: "task-three", title: "List installed apps", status: "done" }];
  overlay();
  const trigger = screen.getByRole("button", { name: "2 tasks" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText(running.title)).toBeNull();
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const rows = screen.getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(within(rows[0]).getByText("Running")).toBeTruthy();
  expect(within(rows[1]).getByText("Done")).toBeTruthy();
  fireEvent.click(within(rows[0]).getByRole("button", { name: "Cancel task" }));
  expect(session.cancel).toHaveBeenCalledWith(running);
  expect(within(rows[1]).queryByRole("button")).toBeNull();
  fireEvent.click(trigger);
  expect(screen.queryByText(running.title)).toBeNull();
});

it("never hides approvals or failures behind the task disclosure", () => {
  session.cards = [running, approval, { ...running, id: "task-failed", title: "Read forecast", status: "failed" }];
  overlay();
  expect(screen.getByRole("button", { name: "1 task" }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("heading", { name: "Read project files" })).toBeTruthy();
  expect(screen.getByText(approval.approval!.description)).toBeTruthy();
  expect(screen.getByText("Read forecast")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
  expect(session.approval).toHaveBeenCalledWith(approval, "approve_once");
});

it("disables decisions during confirmation and after disconnection", () => {
  session.cards = [approval]; session.deciding = [approval.id];
  const view = overlay();
  expect((screen.getByRole("button", { name: "Allow once" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Confirming your decision…")).toBeTruthy();
  session.deciding = []; session.connected = false;
  view.rerender(<AoedeOverlay active onUi={() => ({ status: "failed" })} />);
  expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Cancel task" }) as HTMLButtonElement).disabled).toBe(true);
});
