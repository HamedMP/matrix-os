import { expect, it } from "vitest";
import type { CanonicalChatRunActivity } from "@matrix-os/contracts";
import { planRunActivityRetention } from "../../packages/gateway/src/chat/activity-retention.js";

const base = { chatId: "chat_retention", runId: "run_retention", occurredAt: "2026-10-21T00:00:00.000Z" };
const activity = (id: string): CanonicalChatRunActivity => ({ ...base, id, type: "run.status", status: "running" });
const requested = (id: string): CanonicalChatRunActivity => ({ ...base, id, type: "input.requested", requestId: id, title: "Input" });
const candidates = (events: CanonicalChatRunActivity[]) => events.map(event => ({ id: event.id, event }));

it("drops ordinary incoming previews when every retained slot protects pending input", () => {
  expect(planRunActivityRetention(candidates([requested("one"), requested("two")]), [activity("preview")], [], 2))
    .toEqual({ removedActivityIds: [], droppedActivityIds: ["preview"] });
});
it("fails closed instead of discarding another control when protected history is full", () => {
  expect(() => planRunActivityRetention(candidates([requested("one"), requested("two")]), [requested("three")], [], 2)).toThrow(RangeError);
});
it("keeps terminal outcome evidence while rolling the oldest ordinary preview", () => {
  expect(planRunActivityRetention(candidates([{ ...activity("terminal"), status: "completed" }, activity("old")]), [activity("new")], [], 2))
    .toEqual({ removedActivityIds: ["old"], droppedActivityIds: [] });
});
it("does not remove an activity being replayed in the same transaction", () => {
  const replayed = activity("replayed");
  expect(planRunActivityRetention(candidates([replayed, activity("old")]), [replayed, activity("new")], [], 2))
    .toEqual({ removedActivityIds: ["old"], droppedActivityIds: [] });
});
it("does not split the input ledger while its resolution is being committed", () => {
  const question = requested("question");
  const resolved: CanonicalChatRunActivity = { ...base, id: "answer", type: "input.resolved", requestId: "question", reason: "answered" };
  expect(planRunActivityRetention(candidates([question, activity("old")]), [resolved], [], 2))
    .toEqual({ removedActivityIds: ["old"], droppedActivityIds: [] });
});
it("evicts all history for a resolved input together at a small retention boundary", () => {
  const question = requested("question");
  const submitted: CanonicalChatRunActivity = { ...base, id: "claim", type: "input.submitted", requestId: "question", clientRequestId: "req_claim" };
  const resolved: CanonicalChatRunActivity = { ...base, id: "answer", type: "input.resolved", requestId: "question", reason: "answered" };
  expect(planRunActivityRetention(candidates([question, submitted, resolved]), [activity("new")], [], 3))
    .toEqual({ removedActivityIds: ["question", "claim", "answer"], droppedActivityIds: [] });
});
