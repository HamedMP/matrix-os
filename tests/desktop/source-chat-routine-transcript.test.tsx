// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BotInteraction, CanonicalChatSummary, RoutineChatOriginView } from "@matrix-os/contracts";
import type { ChatAgentClient } from "@matrix-os/ui";
import type { ConversationTurnPresentation } from "../../desktop/src/renderer/src/components/conversation/presentation";
import { SourceChatRoutines } from "../../desktop/src/renderer/src/features/chat/SourceChatRoutines";

const chat = { id: "chat_source", ownerScope: { type: "personal", ownerId: "owner" }, lifecycle: "active" } as CanonicalChatSummary;
const interaction: BotInteraction = {
  interactionId: "in_abcdefgh", chatId: "chat_executor", agentId: "bot_existing", taskId: "task_routine",
  kind: "approval", blocking: true, status: "pending", expiresAt: "2099-01-01T00:00:00.000Z", revision: 1,
  payload: { kind: "approval", tool: "routine.activate", audience: "direct", policyRevision: 1, argsDigest: "a".repeat(64),
    preview: JSON.stringify({
      proposal: { name: "Morning brief", prompt: "Write a private brief.", schedule: { kind: "interval", everyMs: 120000 },
        selection: { instanceId: "matrix_chatgpt_plan", model: "gpt-6-luna" }, authorizedEffects: ["read"] },
      source: { accountId: "account_fixture", computerId: "computer_fixture", grantRevision: 1, definitionRevision: 1 },
    }),
  },
};
const anchor = { sourceChatId: chat.id, anchorMessageId: "msg_source", interaction };
const proposal: ConversationTurnPresentation = {
  id: "turn_source", startedAt: 0, endedAt: 1, work: [], active: false,
  user: { id: "msg_source", kind: "message", role: "user", phase: "commentary", markdown: "Schedule a morning brief", copyText: "Schedule a morning brief", timestamp: 0 },
  final: { id: "msg_reply", kind: "message", role: "assistant", phase: "final", markdown: "I proposed a schedule.", copyText: "I proposed a schedule.", timestamp: 1 },
};
const result: ConversationTurnPresentation = {
  id: "msg_result", startedAt: 2, endedAt: 2, work: [], active: false,
  routineReceipt: { text: "Your scheduled brief", receipt: { type: "routine_receipt", engine: "matrix", kind: "output",
    status: "completed", routineId: `rt_${"a".repeat(24)}`, fireId: `fire_${"b".repeat(24)}`, attempt: 1,
    scheduledFor: "2026-11-06T09:00:00.000Z", canonicalChatId: "chat_executor", canonicalTaskId: "task_routine", model: "gpt-6-luna" } },
};

function renderTranscript(view: Partial<RoutineChatOriginView>, turns = [proposal, result]) {
  const routineOrigin = { get: vi.fn().mockResolvedValue({ sourceChatId: chat.id, pending: [], deliveries: [], hasMore: false, deliveryPending: false, ...view }),
    resolve: vi.fn() };
  const client = { bots: { routineOrigin } } as unknown as ChatAgentClient;
  return render(<SourceChatRoutines client={client} chat={chat} ordinary revision={0} turns={turns} callbacks={{ copyText: vi.fn() }} />);
}

beforeEach(() => vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("retains the handled schedule card between its proposal and the later execution result", async () => {
  renderTranscript({ history: [{ ...anchor, interaction: { ...interaction, status: "resolved", revision: 2 }, decision: "approve" }] });
  const approval = await screen.findByRole("region", { name: "Schedule Morning brief" });
  expect(approval.textContent).toContain("Approved");
  expect(screen.queryByRole("button", { name: "Review in browser" })).toBeNull();
  expect(screen.getByText("I proposed a schedule.").compareDocumentPosition(approval) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(approval.compareDocumentPosition(screen.getByText("Your scheduled brief")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("keeps an off-page pending approval accessible before the loaded results", async () => {
  renderTranscript({ pending: [anchor] }, [result]);
  const approval = await screen.findByRole("region", { name: "Schedule Morning brief" });
  expect(screen.getByRole("button", { name: "Review in browser" })).toBeTruthy();
  expect(screen.getByText("From an earlier message in this Chat.")).toBeTruthy();
  expect(approval.compareDocumentPosition(screen.getByText("Your scheduled brief")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("shows a current Schedules edit review after the transcript instead of beside the old proposal", async () => {
  const payload = interaction.payload;
  if (payload?.kind !== "approval") throw new Error("Expected the approval fixture");
  const preview = JSON.parse(payload.preview);
  preview.source = { ...preview.source, routineId: `rt_${"a".repeat(24)}`, baseRoutineRevision: 1 };
  renderTranscript({ pending: [{ ...anchor, interaction: { ...interaction, payload: { ...payload, preview: JSON.stringify(preview) } } }] });
  const edit = await screen.findByRole("region", { name: "Update schedule Morning brief" });
  expect(screen.getByText("Your scheduled brief").compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole("button", { name: "Review in browser" })).toBeTruthy();
});
