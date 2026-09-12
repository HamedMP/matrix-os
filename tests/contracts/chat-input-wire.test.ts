import { expect, it } from "vitest";
import { projectChatMessageFrame, projectChatMessageResponse, chatMessageVersionUrl } from "@matrix-os/contracts";
import type { CanonicalChatRunActivity, CanonicalChatTransportFrame } from "@matrix-os/contracts";
const base = { id: "evt_input", chatId: "chat_wire", runId: "run_wire", occurredAt: "2026-09-11T00:00:00.000Z" };
const activities: CanonicalChatRunActivity[] = [
  { ...base, type: "input.requested", requestId: "input_wire", title: "Question", questions: [{ questionId: "q", header: "Name", question: "Which name?", allowOther: true, secret: false }] },
  { ...base, id: "evt_claim", type: "input.submitted", requestId: "input_wire", clientRequestId: "req_submit" },
  { ...base, id: "evt_resolved", type: "input.resolved", requestId: "input_wire", reason: "answered" },
];
it("keeps strict older clients compatible even when they opt into message v2", () => {
  const result = projectChatMessageResponse({ activities }, "2", "0");
  expect(result.activities).toEqual([
    { ...base, type: "input.requested", requestId: "input_wire", title: "Question" },
    { ...base, id: "evt_resolved", type: "input.resolved", requestId: "input_wire" },
  ]);
  expect(activities[0]).toHaveProperty("questions");
});
it("preserves full structured requests for input-aware snapshots and live frames", () => {
  expect(projectChatMessageResponse({ activities }, "2", "1").activities).toEqual(activities);
  const frame = { type: "chat.content", event: { cursor: 1 }, content: { activities } } as CanonicalChatTransportFrame;
  expect(projectChatMessageFrame(frame, "2", "1")).toEqual(frame);
  expect(projectChatMessageFrame(frame, "2", "0")).toMatchObject({ content: { activities: [expect.not.objectContaining({ type: "input.submitted" }), expect.anything()] } });
  expect(chatMessageVersionUrl("/api/chats/chat_wire?limit=20")).toBe("/api/chats/chat_wire?limit=20&messageVersion=2&inputVersion=1");
});
