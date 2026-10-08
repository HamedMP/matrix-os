// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AoedeCard } from "@matrix-os/contracts";
import { AoedeOverlay } from "../../shell/src/aoede/AoedeOverlay";
import { useVocalStore } from "../../shell/src/stores/vocal";

const session = vi.hoisted(() => ({
  status: "active", connected: true, captions: [] as {id: string; role: string; text: string}[], cards: [] as AoedeCard[],
  muted: false, toggleMute: vi.fn(), refreshReadiness: vi.fn(),
  readiness: { status: "ready", message: "Tasks are ready" },
  taskErrors: [] as {type: string; sessionId: string; delegationId: string; outcome: string; message: string}[],
  captioning: false, recoveryError: false, deciding: [] as string[], actionError: false,
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
beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn()})));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  session.captioning = false; session.recoveryError = false;
  session.cards = []; session.captions = []; session.taskErrors = []; session.readiness = {status: "ready", message: "Tasks are ready"}; session.muted = false; session.deciding = []; session.connected = true; session.status = "active"; vi.clearAllMocks();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows ordinary tasks immediately with exact cancellation and controls outside the list", () => {
  session.cards = [running, { ...running, id: "task-three", title: "List installed apps", status: "done" }];
  overlay();
  expect(screen.getByText(running.title)).toBeTruthy();
  const rows = screen.getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(within(rows[0]).getByText("Working in Chat")).toBeTruthy();
  expect(within(rows[1]).getByText("Done")).toBeTruthy();
  fireEvent.click(within(rows[0]).getByRole("button", { name: "Cancel task" }));
  expect(session.cancel).toHaveBeenCalledWith(running);
  expect(within(rows[1]).queryByRole("button")).toBeNull();
  expect(within(screen.getByRole("region", {name: "Voice tasks"})).queryByRole("button", {name: "Mute"})).toBeNull();
  fireEvent.click(screen.getByRole("button", {name: "Mute"}));
  expect(session.toggleMute).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", {name: "End session"}));
  expect(session.stop).toHaveBeenCalledWith("closed");
});

it("never hides approvals or failures behind the task disclosure", () => {
  session.cards = [running, approval, { ...running, id: "task-failed", title: "Read forecast", status: "failed" }];
  overlay();
  expect(screen.getByText(running.title)).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Read project files" })).toBeTruthy();
  expect(screen.getByText(approval.approval!.description)).toBeTruthy();
  expect(screen.getByText("Read forecast")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
  expect(session.approval).toHaveBeenCalledWith(approval, "approve_once");
});

it("shows the full real transcript and keeps only privacy behind disclosure", () => {
  session.captions = [{id: "one", role: "user", text: "Open my notes"}, {id: "two", role: "assistant", text: "Notes are open"}];
  overlay();
  const transcript = screen.getByRole("region", {name: "Conversation transcript"});
  expect(within(transcript).getByText("Open my notes")).toBeTruthy();
  expect(within(transcript).getByText("Notes are open")).toBeTruthy();
  fireEvent.click(screen.getByText("Conversation & privacy"));
  fireEvent.click(screen.getByRole("button", {name: "Delete saved voice text"}));
  expect(session.clearRecovery).toHaveBeenCalledOnce();
});

it("keeps voice available when task setup is missing and dismisses before opening Settings", async () => {
  session.readiness = {status: "setup_required", message: "Connect a task provider"};
  const settings = vi.fn(() => {
    expect(session.stop).toHaveBeenCalledWith("closed");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  window.addEventListener("matrix:open-provider-settings", settings);
  function Harness() {
    const active = useVocalStore(state => state.active);
    return <AoedeOverlay active={active} onUi={() => ({status: "failed"})} />;
  }
  useVocalStore.getState().setActive(true);
  render(<Harness />);
  expect(screen.getByText("Listening")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name: "Recheck"}));
  expect(session.refreshReadiness).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", {name: "Connect harness"}));
  await waitFor(() => expect(settings).toHaveBeenCalledOnce());
  window.removeEventListener("matrix:open-provider-settings", settings);
});

it("does not retry uncertain tasks and gates fresh starts on connection", () => {
  session.status = "interrupted"; session.connected = false;
  session.taskErrors = [{type: "aoede:task_error", sessionId: "s", delegationId: "d", outcome: "uncertain", message: "Task acceptance was not confirmed"}];
  overlay();
  expect(screen.getByText(/Check Chat before trying again/)).toBeTruthy();
  expect(screen.queryByRole("button", {name: /Retry/})).toBeNull();
  expect((screen.getByRole("button", {name: "Start fresh session"}) as HTMLButtonElement).disabled).toBe(true);
});

it("renders only permitted approval decisions and disables them after the voice session ends", () => {
  session.cards = [{...approval, approval: {...approval.approval!, allowedDecisions: ["deny"]}}];
  session.status = "closed";
  overlay();
  expect(screen.queryByRole("button", {name: "Allow once"})).toBeNull();
  expect((screen.getByRole("button", {name: "Deny"}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", {name: "Start fresh session"}));
  expect(session.start).toHaveBeenCalledOnce();
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

it("uses static artwork for reduced motion and real empty states", () => {
  const view = overlay();
  expect(document.querySelector(".aoede-static-orb")).toBeTruthy();
  expect(document.querySelector(".aoede-orb-canvas")).toBeNull();
  expect(screen.getByText("No actions yet.")).toBeTruthy();
  expect(screen.getByText("No conversation yet")).toBeTruthy();
  expect(view.container.querySelector("canvas")).toBeNull();
});

it("shows mute state and supports unmuting without starting another session", () => {
  session.muted = true;
  overlay();
  const unmute = screen.getByRole("button", {name: "Unmute"});
  expect(unmute.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText("Microphone paused")).toBeTruthy();
  fireEvent.click(unmute);
  expect(session.toggleMute).toHaveBeenCalledOnce();
  expect(session.start).not.toHaveBeenCalled();
});

it("does not misreport the text limit during ordinary assistant captions", () => {
  session.captioning = true;
  overlay();
  expect(screen.queryByText(/text has reached its limit/)).toBeNull();
  expect(screen.getByText(/You can interrupt anytime/)).toBeTruthy();
});

it("discloses unavailable recovery without claiming saved text is ready", () => {
  session.status = "interrupted"; session.recoveryError = true;
  overlay();
  expect(screen.getByText(/Saved conversation could not be checked/)).toBeTruthy();
  expect(screen.queryByText(/Start fresh with saved text/)).toBeNull();
});

it("dismisses with Escape and restores the previously focused element", async () => {
  const trigger = document.createElement("button");
  document.body.append(trigger); trigger.focus();
  const view = overlay();
  expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(document.activeElement!, {key: "Escape"});
  expect(session.stop).toHaveBeenCalledWith("closed");
  view.rerender(<AoedeOverlay active={false} onUi={() => ({status: "failed"})} />);
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  trigger.remove();
});
