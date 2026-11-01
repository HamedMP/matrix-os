// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScheduleCenter } from "../../../packages/ui/src/chat-agents/bots/ScheduleCenter.js";
import { ChatAgentsRailSection } from "../../../packages/ui/src/chat-agents/ChatAgentsRailSection.js";
import { ChatAgentsContent } from "../../../packages/ui/src/chat-agents/ChatAgentsContent.js";
import { ChatAgentsWorkspace } from "../../../packages/ui/src/chat-agents/ChatAgentsNavigation.js";
import type { ChatAgentClient } from "../../../packages/ui/src/chat-agents/client.js";
import type { BotRoutineCenterItem } from "@matrix-os/contracts";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture";

afterEach(cleanup);
const routine: BotRoutineCenterItem = { routineId: "rt_0123456789abcdef01234567", botId: saved.id, chatId: "chat_fixture",
  proposal: { name: "Morning brief", prompt: "Write a private brief.", schedule: { kind: "interval", everyMs: 3600000 },
    selection: { instanceId: "matrix_chatgpt_plan", model: "gpt-model" }, authorizedEffects: ["read"] },
  computerId: "My Computer", status: "active", revision: 1, nextFireAt: "2099-01-01T10:00:00.000Z",
  targetAvailable: true, sourceAvailable: true, requiresReview: false, lastFire: null };

const editReview = (baseRevision: number, name: string) => ({interaction: {interactionId: "in_0123456789abcdef01234567", chatId: routine.chatId,
    agentId: routine.botId, taskId: "task_fixture", kind: "approval", blocking: false, status: "pending", expiresAt: "2099-01-01T00:00:00.000Z", revision: 1,
    payload: {kind: "approval", tool: "routine.activate", argsDigest: "a".repeat(64), audience: "direct", policyRevision: 3,
      preview: JSON.stringify({proposal: {...routine.proposal, name}, source: {accountId: "account_fixture", computerId: "computer_fixture", grantRevision: 3,
        definitionRevision: 1, routineId: routine.routineId, baseRoutineRevision: baseRevision}})}}});

it("opens an owner schedule center from Chat, manages the exact task revision and preserves the retained chat", async () => {
  const base = clientFixture(); base.list.mockResolvedValue({ enabled: true, agents: [saved] });
  let current = routine;
  const routines = { list: vi.fn(async () => ({ items: [current], pending: [], nextCursor: null })),
    detail: vi.fn(async () => ({ routine: current, history: [] })),
    review: vi.fn(), control: vi.fn(async (_id, input) => { current = { ...current, status: input.status, revision: current.revision + 1 }; return { routineId: current.routineId, status: current.status, revision: current.revision }; }) };
  const client = { ...base, bots: { routines } } as unknown as ChatAgentClient;
  render(<ChatAgentsWorkspace><ChatAgentsRailSection client={client}/>
    <ChatAgentsContent client={client} scopeKey="owner-computer"><p>Retained private chat</p></ChatAgentsContent>
  </ChatAgentsWorkspace>);
  fireEvent.click(await screen.findByRole("button", { name: "Schedules" }));
  expect(await screen.findByRole("heading", { name: "Schedules" })).toBeTruthy();
  expect(await screen.findByText("Morning brief")).toBeTruthy();
  expect(screen.getByText("Write a private brief.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Pause Morning brief" }));
  await waitFor(() => expect(routines.control).toHaveBeenCalledExactlyOnceWith(routine.routineId, { status: "paused", baseRevision: 1 }));
  expect(await screen.findByRole("button", { name: "Resume Morning brief" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "View Morning brief" }));
  expect(await screen.findByText("No runs yet.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close schedules" }));
  expect(screen.getByText("Retained private chat")).toBeTruthy();
});

it("keeps a failed edit draft, requires a new review and never calls control to apply edits", async () => {
  const base = clientFixture();
  const routines = {list: vi.fn(async () => ({items: [routine], pending: [], nextCursor: null})),
    detail: vi.fn(async () => ({routine, history: []})), control: vi.fn(), review: vi.fn().mockRejectedValue(new Error("private provider /home/path"))};
  const client = {...base, bots: {routines}} as unknown as ChatAgentClient;
  render(<ChatAgentsWorkspace><ChatAgentsRailSection client={client}/><ChatAgentsContent client={client} scopeKey="owner"><p>Chat</p></ChatAgentsContent></ChatAgentsWorkspace>);
  fireEvent.click(await screen.findByRole("button", {name: "Schedules"}));
  fireEvent.click(await screen.findByRole("button", {name: "View Morning brief"}));
  fireEvent.click(await screen.findByRole("button", {name: "Edit schedule"}));
  fireEvent.change(screen.getByRole("textbox", {name: "Task name"}), {target: {value: "Changed brief"}});
  fireEvent.click(screen.getByRole("button", {name: "Review changes"}));
  await screen.findByRole("alert");
  expect((screen.getByRole("textbox", {name: "Task name"}) as HTMLInputElement).value).toBe("Changed brief");
  expect(screen.getByRole("alert").textContent).not.toMatch(/private provider|\/home/);
  expect(routines.review).toHaveBeenCalledExactlyOnceWith(routine.routineId, {baseRevision: 1, name: "Changed brief", prompt: routine.proposal.prompt, schedule: routine.proposal.schedule});
  expect(routines.control).not.toHaveBeenCalled();
});

it("confirms archive separately and retains the task when the server rejects a stale revision", async () => {
  const base = clientFixture(); const routines = {list: vi.fn(async () => ({items: [routine], pending: [], nextCursor: null})),
    detail: vi.fn(), review: vi.fn(), control: vi.fn().mockRejectedValue({status: 409})};
  const client = {...base, bots: {routines}} as unknown as ChatAgentClient;
  render(<ChatAgentsWorkspace><ChatAgentsRailSection client={client}/><ChatAgentsContent client={client} scopeKey="owner"><p>Chat</p></ChatAgentsContent></ChatAgentsWorkspace>);
  fireEvent.click(await screen.findByRole("button", {name: "Schedules"}));
  fireEvent.click(await screen.findByRole("button", {name: "Archive Morning brief"}));
  expect(routines.control).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", {name: "Confirm archive"}));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", {name: "View Morning brief"})).toBeTruthy();
  expect(screen.getByRole("dialog", {name: "Archive schedule"})).toBeTruthy();
  expect(routines.control).toHaveBeenCalledExactlyOnceWith(routine.routineId, {baseRevision: 1, status: "archived"});
});


it("does not replace Archived results with an old Current refresh when a pending mutation settles", async () => {
  const base = clientFixture(); let finish!: (value: unknown) => void;
  const routines = {list: vi.fn(async (query = {}) => ({items: "archived" in query ? [] : [routine], pending: [], nextCursor: null})),
    detail: vi.fn(), review: vi.fn(), control: vi.fn(() => new Promise(resolve => { finish = resolve; }))};
  render(<ScheduleCenter client={{...base, bots: {routines}} as unknown as ChatAgentClient} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", {name: "Pause Morning brief"}));
  fireEvent.click(screen.getByRole("button", {name: "Archived"}));
  await screen.findByText("No archived schedules");
  await act(async () => finish({routineId: routine.routineId, status: "paused", revision: 2}));
  await waitFor(() => expect(routines.list).toHaveBeenCalledTimes(3));
  expect(routines.list).toHaveBeenLastCalledWith({archived: "true"});
  expect(screen.getByText("No archived schedules")).toBeTruthy();
  expect(screen.queryByRole("button", {name: "View Morning brief"})).toBeNull();
});

it("refreshes the selected revision without losing a failed edit and requires an explicit review against the new version", async () => {
  const base = clientFixture();
  let current = routine;
  const routines = {list: vi.fn(async () => ({items: [current], pending: [], nextCursor: null})),
    detail: vi.fn(async () => ({routine: current, history: []})), control: vi.fn(), review: vi.fn().mockRejectedValue({status: 409})};
  render(<ScheduleCenter client={{...base, bots: {routines}} as unknown as ChatAgentClient} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", {name: "View Morning brief"}));
  fireEvent.click(await screen.findByRole("button", {name: "Edit schedule"}));
  fireEvent.change(screen.getByRole("textbox", {name: "Task name"}), {target: {value: "My retained draft"}});
  fireEvent.click(screen.getByRole("button", {name: "Review changes"}));
  await screen.findByRole("alert");
  current = {...routine, revision: 2, proposal: {...routine.proposal, name: "Other client's saved name"}};
  fireEvent.click(screen.getByRole("button", {name: "Refresh"}));
  const review = await screen.findByRole("button", {name: "Review against revision 2"});
  expect((screen.getByRole("textbox", {name: "Task name"}) as HTMLInputElement).value).toBe("My retained draft");
  expect(screen.getByText(/Current saved task:/)).toBeTruthy();
  expect(routines.review).toHaveBeenCalledTimes(1);
  fireEvent.click(review);
  await waitFor(() => expect(routines.review).toHaveBeenLastCalledWith(routine.routineId, expect.objectContaining({baseRevision: 2, name: "My retained draft"})));
});

it("keeps an edit draft when pausing its schedule and reviews against the accepted pause revision", async () => {
  const base = clientFixture(); let current = routine;
  const routines = {list: vi.fn(async () => ({items: [current], pending: [], nextCursor: null})),
    detail: vi.fn(async () => ({routine: current, history: []})), review: vi.fn().mockRejectedValue({status: 409}),
    control: vi.fn(async () => {current = {...current, revision: 2, status: "paused"}; return {routineId: current.routineId, revision: 2, status: "paused"};})};
  render(<ScheduleCenter client={{...base, bots: {routines}} as unknown as ChatAgentClient} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", {name: "View Morning brief"}));
  fireEvent.click(await screen.findByRole("button", {name: "Edit schedule"}));
  fireEvent.change(screen.getByRole("textbox", {name: "Task name"}), {target: {value: "Keep on pause"}});
  fireEvent.click(screen.getAllByRole("button", {name: "Pause Morning brief"})[0]!);
  const review = await screen.findByRole("button", {name: "Review against revision 2"});
  expect((screen.getByRole("textbox", {name: "Task name"}) as HTMLInputElement).value).toBe("Keep on pause");
  fireEvent.click(review);
  await waitFor(() => expect(routines.review).toHaveBeenCalledWith(routine.routineId, expect.objectContaining({baseRevision: 2, name: "Keep on pause"})));
});

it("cancels an outdated pending edit, retains its draft and explicitly reviews it at the new pause revision", async () => {
  const base = clientFixture(); let current = routine, finishReview!: (value: unknown) => void;
  const makeReview = editReview;
  const routines = {list: vi.fn(async () => ({items: [current], pending: [], nextCursor: null})), detail: vi.fn(async () => ({routine: current, history: []})),
    review: vi.fn().mockImplementationOnce(() => new Promise(resolve => {finishReview = resolve;})).mockResolvedValue(makeReview(2, "Retained pending draft")),
    control: vi.fn(async () => {current = {...current, status: "paused", revision: 2}; return {routineId: current.routineId, status: "paused", revision: 2};})};
  const resolve = vi.fn(async () => ({interaction: {interactionId: "in_0123456789abcdef01234567", status: "resolved", revision: 2}}));
  render(<ScheduleCenter client={{...base, bots: {routines, resolve}} as unknown as ChatAgentClient} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", {name: "View Morning brief"}));
  fireEvent.click(await screen.findByRole("button", {name: "Edit schedule"}));
  fireEvent.change(screen.getByRole("textbox", {name: "Task name"}), {target: {value: "Retained pending draft"}});
  fireEvent.click(screen.getByRole("button", {name: "Review changes"}));
  fireEvent.click(screen.getAllByRole("button", {name: "Pause Morning brief"})[0]!);
  await waitFor(() => expect(routines.control).toHaveBeenCalledTimes(1));
  await act(async () => finishReview(makeReview(1, "Retained pending draft")));
  const approve = await screen.findByRole("button", {name: "Approve changes"});
  expect((approve as HTMLButtonElement).disabled).toBe(true);
  expect(resolve).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", {name: "Cancel"}));
  const review = await screen.findByRole("button", {name: "Review against revision 2"});
  expect((screen.getByRole("textbox", {name: "Task name"}) as HTMLInputElement).value).toBe("Retained pending draft");
  expect(resolve).toHaveBeenCalledExactlyOnceWith(routine.chatId, "in_0123456789abcdef01234567", {kind: "approval", decision: "deny", baseRevision: 1});
  expect(routines.review).toHaveBeenCalledTimes(1);
  fireEvent.click(review);
  await waitFor(() => expect(routines.review).toHaveBeenLastCalledWith(routine.routineId, expect.objectContaining({baseRevision: 2, name: "Retained pending draft"})));
});


it("uses a fresh pending read to recover a review denied in Chat without discarding the draft", async () => {
  const base = clientFixture();
  const routines = {list: vi.fn(async () => ({items: [routine], pending: [], nextCursor: null})), detail: vi.fn(async () => ({routine, history: []})),
    control: vi.fn(), review: vi.fn().mockResolvedValue(editReview(1, "Keep after another Chat denied"))};
  const resolve = vi.fn();
  render(<ScheduleCenter client={{...base, bots: {routines, resolve}} as unknown as ChatAgentClient} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", {name: "View Morning brief"}));
  fireEvent.click(await screen.findByRole("button", {name: "Edit schedule"}));
  fireEvent.change(screen.getByRole("textbox", {name: "Task name"}), {target: {value: "Keep after another Chat denied"}});
  fireEvent.click(screen.getByRole("button", {name: "Review changes"}));
  await screen.findByRole("button", {name: "Approve changes"});
  fireEvent.click(screen.getByRole("button", {name: "Refresh"}));
  fireEvent.click(await screen.findByRole("button", {name: "Return to draft"}));
  expect((screen.getByRole("textbox", {name: "Task name"}) as HTMLInputElement).value).toBe("Keep after another Chat denied");
  expect(resolve).not.toHaveBeenCalled();
  expect(routines.review).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", {name: "Review changes"}));
  await waitFor(() => expect(routines.review).toHaveBeenCalledTimes(2));
});

it("does not invalidate a new pending review with a list request started before its acknowledgement", async () => {
  const base = clientFixture(); let finishReview!: (value: unknown) => void, finishList!: (value: unknown) => void;
  const page = {items: [routine], pending: [], nextCursor: null};
  const routines = {list: vi.fn().mockResolvedValue(page), detail: vi.fn(async () => ({routine, history: []})), control: vi.fn(),
    review: vi.fn(() => new Promise(resolve => {finishReview = resolve;}))};
  render(<ScheduleCenter client={{...base, bots: {routines, resolve: vi.fn()}} as unknown as ChatAgentClient} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", {name: "View Morning brief"}));
  fireEvent.click(await screen.findByRole("button", {name: "Edit schedule"}));
  fireEvent.click(screen.getByRole("button", {name: "Review changes"}));
  routines.list.mockImplementationOnce(() => new Promise(resolve => {finishList = resolve;}));
  fireEvent.click(screen.getByRole("button", {name: "Refresh"}));
  await waitFor(() => expect(finishList).toBeTypeOf("function"));
  await act(async () => finishReview(editReview(1, routine.proposal.name)));
  await screen.findByRole("button", {name: "Approve changes"});
  await act(async () => finishList(page));
  expect((screen.getByRole("button", {name: "Approve changes"}) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByRole("button", {name: "Cancel"})).toBeTruthy();
  expect(screen.queryByRole("button", {name: "Return to draft"})).toBeNull();
});

it("disables the center's pending-card copy when pausing changes its target revision", async () => {
  const base = clientFixture(); let current = routine;
  const routines = {list: vi.fn(async () => ({items: [current], pending: [editReview(1, "Pending changed task").interaction], nextCursor: null})),
    detail: vi.fn(), review: vi.fn(), control: vi.fn(async () => {current = {...current, status: "paused", revision: 2}; return {routineId: current.routineId, status: "paused", revision: 2};})};
  render(<ScheduleCenter client={{...base, bots: {routines, resolve: vi.fn()}} as unknown as ChatAgentClient} onClose={vi.fn()}/>);
  const approve = await screen.findByRole("button", {name: "Approve changes"});
  expect((approve as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", {name: "Pause Morning brief"}));
  await waitFor(() => expect((screen.getByRole("button", {name: "Approve changes"}) as HTMLButtonElement).disabled).toBe(true));
  expect(screen.getByRole("button", {name: "Cancel"})).toBeTruthy();
});

it("retains an accepted pause revision when list refresh fails and cannot re-enable its old approval", async () => {
  const base = clientFixture();
  const routines = {list: vi.fn().mockResolvedValueOnce({items: [routine], pending: [editReview(1, "Pending changed task").interaction], nextCursor: null}).mockRejectedValue(new Error("Fixture refresh failed")),
    detail: vi.fn(), review: vi.fn(), control: vi.fn(async () => ({routineId: routine.routineId, status: "paused", revision: 2}))};
  render(<ScheduleCenter client={{...base, bots: {routines, resolve: vi.fn()}} as unknown as ChatAgentClient} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", {name: "Pause Morning brief"}));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", {name: "Resume Morning brief"})).toBeTruthy();
  expect((screen.getByRole("button", {name: "Approve changes"}) as HTMLButtonElement).disabled).toBe(true);
});
