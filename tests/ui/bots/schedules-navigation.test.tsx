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
