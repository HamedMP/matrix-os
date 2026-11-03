// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BotInteraction, BotTaskSummary, ResolveBotInteractionRequest } from "@matrix-os/contracts";
import { BotChatPanel } from "../../../packages/ui/src/chat-agents/bots/BotChatPanel.js";
import { ConversationTranscript } from "../../../desktop/src/renderer/src/components/conversation/transcript.js";
import { botTranscriptPlacement, BotTranscriptRunState, BotTranscriptFallback } from "../../../shell/src/components/BotTranscriptState.js";
import { saved } from "../../desktop/chat-agents-fixture.js";

const question: BotInteraction = {
  interactionId: "in_recover_answer", chatId: "chat_recover_answer", agentId: "bot_recover_answer", taskId: "task_recover_answer",
  kind: "question", blocking: true, status: "pending", expiresAt: "2099-01-01T00:00:00.000Z", revision: 1,
  payload: { kind: "question", questions: [{ questionId: "target", header: "Target", question: "Which company?", allowOther: true, secret: false }] },
};
const recovery: BotInteraction = { ...question, status: "resolved", revision: 2, recoveryAvailable: true };
const task: BotTaskSummary = { taskId: question.taskId, chatId: question.chatId, agentId: question.agentId,
  runId: "run_asking_original", status: "waiting_person", revision: 2, updatedAt: "2026-10-27T00:00:00.000Z" };
const SURFACES = ["Web Canvas", "Web Desktop", "Electron Desktop"] as const;
type Surface = typeof SURFACES[number];

beforeEach(() => { globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver; });
afterEach(cleanup);

function clientFor(initial: readonly BotInteraction[] = [question]) {
  let interactions = initial, tasks: readonly BotTaskSummary[] = [task];
  const client = { bots: {
    directBot: vi.fn(async () => question.agentId), interactions: vi.fn(async () => interactions), tasks: vi.fn(async () => tasks),
    authority: vi.fn(async () => ({ agentId: question.agentId, revision: 1, grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } })),
    resolve: vi.fn(async (_chatId: string, _interactionId: string, input: ResolveBotInteractionRequest) => {
      if (input.kind === "resume") {
        interactions = [];
        tasks = [{ ...task, runId: "run_continued", status: "running", revision: 3 }];
        return { interaction: { interactionId: question.interactionId, status: "resolved" as const, revision: 2 } };
      }
      interactions = [recovery];
      return { interaction: { interactionId: question.interactionId, status: "resolved" as const, revision: 2 }, continuationPending: true };
    }),
  }, list: vi.fn(async () => ({ enabled: true, agents: [{ ...saved, id: question.agentId, recipeRef: { recipeId: "writing-bot", version: "1" } }] })) };
  return client;
}

/** Web Canvas and Web Desktop share these ChatApp transcript slots; Electron uses its actual transcript renderer. */
function transcript(surface: Surface, includeAskingRun = true) {
  if (surface === "Electron Desktop") return <ConversationTranscript turns={[
    { id: "turn_unrelated", runIds: ["run_unrelated"], startedAt: 1, endedAt: 2, active: false, work: [] },
    ...(includeAskingRun ? [{ id: "turn_asking_original", runIds: [task.runId!], startedAt: 3, endedAt: 4, active: false, work: [],
      final: { kind: "message" as const, id: "msg_original", role: "assistant" as const, phase: "final" as const,
        markdown: "I need your answer.", copyText: "I need your answer.", timestamp: 4 } }] : []),
  ]} callbacks={{ copyText: vi.fn() }}/>;
  const runs = includeAskingRun ? ["run_unrelated", task.runId!] : ["run_unrelated"];
  const groups = runs.map((runId, index) => ({ type: "message" as const,
    message: { id: `msg_${index}`, role: "assistant" as const, content: "I need your answer.", requestId: runId, timestamp: index } }));
  const placement = botTranscriptPlacement(groups);
  return <section aria-label={`${surface} transcript`}>
    {groups.map((_, index) => <BotTranscriptRunState key={index} placement={placement} index={index}/>)}
    <BotTranscriptFallback placement={placement}/>
  </section>;
}

const bodyFor = (surface: Surface) => surface === "Electron Desktop" ? "turn_asking_original" : task.runId;

it.each(SURFACES)("keeps Resume after admission fails, status refreshes and Chat reopens in %s", async surface => {
  const client = clientFor();
  const content = transcript(surface);
  const view = render(<BotChatPanel chatId={question.chatId} client={client as never}>{content}</BotChatPanel>);
  fireEvent.change(await screen.findByRole("textbox", { name: "Answer Target" }), { target: { value: "Acme" } });
  fireEvent.click(screen.getByRole("button", { name: "Answer" }));
  await waitFor(() => expect(client.bots.interactions.mock.calls.length).toBeGreaterThan(1));
  let resume = await screen.findByRole("button", { name: "Resume" });
  expect(resume.closest("[data-agent-message-body]")?.getAttribute("data-agent-message-body")).toBe(bodyFor(surface));
  expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
  expect(screen.getAllByRole("button", { name: "Resume" })).toHaveLength(1);
  view.unmount();
  render(<BotChatPanel chatId={question.chatId} client={client as never}>{content}</BotChatPanel>);
  resume = await screen.findByRole("button", { name: "Resume" });
  expect(resume.closest("[data-agent-message-body]")?.getAttribute("data-agent-message-body")).toBe(bodyFor(surface));
  fireEvent.click(resume);
  await waitFor(() => expect(client.bots.resolve).toHaveBeenLastCalledWith(question.chatId, question.interactionId, { kind: "resume", baseRevision: 2 }));
  expect(client.bots.resolve).toHaveBeenCalledTimes(2);
  expect(client.bots.resolve).toHaveBeenNthCalledWith(1, question.chatId, question.interactionId,
    { kind: "question", baseRevision: 1, structuredAnswers: { target: ["Acme"] } });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Resume" })).toBeNull());
});

it.each(SURFACES)("keeps saved recovery reachable in the %s transcript fallback when the source run is truncated", async surface => {
  render(<BotChatPanel chatId={question.chatId} client={clientFor([recovery]) as never}>{transcript(surface, false)}</BotChatPanel>);
  const resume = await screen.findByRole("button", { name: "Resume" });
  expect(resume.closest("[data-agent-message-body]")?.getAttribute("data-agent-message-body")).toBe("unassigned");
  expect(screen.getAllByRole("button", { name: "Resume" })).toHaveLength(1);
  expect(screen.queryByRole("textbox", { name: "Answer Target" })).toBeNull();
});

it("keeps expired saved answers disabled after the parent refreshes", async () => {
  const client = clientFor([{ ...recovery, expiresAt: "2000-01-01T00:00:00.000Z" }]);
  render(<BotChatPanel chatId={question.chatId} client={client as never}>{transcript("Web Desktop")}</BotChatPanel>);
  await screen.findByText("This request has expired.");
  const resume = screen.getByRole("button", { name: "Resume" }) as HTMLButtonElement;
  expect(resume.disabled).toBe(true);
  fireEvent.click(resume);
  expect(client.bots.resolve).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
});

it("disables retained Resume when a later authenticated status read fails", async () => {
  const client = clientFor([recovery]), content = transcript("Web Desktop");
  const view = render(<BotChatPanel chatId={question.chatId} client={client as never} refreshKey={0}>{content}</BotChatPanel>);
  await screen.findByRole("button", { name: "Resume" });
  client.bots.interactions.mockRejectedValue(new Error("synthetic private connection error"));
  view.rerender(<BotChatPanel chatId={question.chatId} client={client as never} refreshKey={1}>{content}</BotChatPanel>);
  await screen.findByRole("alert");
  const resume = screen.getByRole("button", { name: "Resume" }) as HTMLButtonElement;
  expect(resume.disabled).toBe(true);
  fireEvent.click(resume);
  expect(client.bots.resolve).not.toHaveBeenCalled();
});

it.each([
  ["resolved without recovery authority", { ...recovery, recoveryAvailable: undefined }],
  ["hidden payload", { ...recovery, payload: undefined }],
  ["nonblocking question", { ...recovery, blocking: false }],
  ["cancelled question", { ...recovery, status: "cancelled" }],
  ["expired question", { ...recovery, status: "expired" }],
  ["different Chat", { ...recovery, chatId: "chat_other" }],
  ["different agent", { ...recovery, agentId: "bot_other" }],
  ["account choice", { ...recovery, kind: "account_choice", payload: { kind: "account_choice", service: "gmail", options: [{ connectionId: "conn_work", label: "Work" }] } }],
  ["approval", { ...recovery, kind: "approval", payload: { kind: "approval", tool: "integration.call", argsDigest: "a".repeat(64), audience: "direct", preview: "Send", policyRevision: 1 } }],
  ["connect request", { ...recovery, kind: "connect_request", payload: { kind: "connect_request", service: "gmail", access: ["read"], benefit: "Read mail", connectRequestId: "cr_request" } }],
] as const)("does not revive actions for %s in the real parent", async (_label, record) => {
  const client = clientFor([record as BotInteraction]);
  render(<BotChatPanel chatId={question.chatId} client={client as never}>{transcript("Web Desktop")}</BotChatPanel>);
  await screen.findByText("Waiting for your answer");
  expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
  expect(client.bots.resolve).not.toHaveBeenCalled();
});
