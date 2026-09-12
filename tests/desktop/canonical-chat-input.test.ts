import { expect, it, vi } from "vitest";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { canonicalChatPresentation } from "@desktop/renderer/src/features/chat/canonical-chat-presentation";
import { createCanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";

it("preserves structured questions and fences closed requests in the Electron transcript", () => {
  const { snapshot } = createCanonicalChatFixture("approval_required");
  const run = { ...snapshot.runs[0]!, status: "waiting_for_input" as const };
  const question = { questionId: "q1", header: "Choice", question: "Which folder?", allowOther: true, secret: false };
  const detail = { ...snapshot, runs: [run], activities: [{ id: "evt_input", chatId: run.chatId, runId: run.id,
    occurredAt: run.updatedAt, type: "input.requested" as const, requestId: "input_q", title: "Choose a folder", questions: [question] }] };
  const request = canonicalChatPresentation(detail)[0]?.work.find(item => item.kind === "request");
  expect(request).toMatchObject({ input: { requestId: "input_q", runId: run.id, questions: [question], pending: true } });
  detail.runs[0] = { ...run, status: "completed" } as typeof run;
  expect(canonicalChatPresentation(detail)[0]?.work.find(item => item.kind === "request")).toMatchObject({ input: { pending: false } });
});
it("submits answers through the canonical input route with stable request identity", async () => {
  const post = vi.fn().mockResolvedValue({ requestId: "input_q", submission: "accepted" });
  const client = createCanonicalChatClient({ post } as never);
  const body = { clientRequestId: "req_submit", structuredAnswers: { q1: ["Inbox"] } };
  await client.submitInput("chat_input", "run_input", "input_q", body);
  expect(post).toHaveBeenCalledWith("/api/chats/chat_input/runs/run_input/inputs/input_q", body);
});
