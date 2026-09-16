import { describe, expect, it } from "vitest";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { mergeCanonicalChatRecord, compareCanonicalChatActivity } from "../../packages/ui/src/canonical-chat-record";
const record = (title: string, titleVersion: number, revision: number, activityAt = "2026-09-01T00:00:00.000Z") => ({
  chat: { id: "chat_a", title, titleVersion, revision, activityAt, createdAt: activityAt, updatedAt: activityAt },
}) as CanonicalChatRecord;
describe("canonical Chat metadata reconciliation", () => {
  it("preserves a newer manual title through stale list/detail/stream snapshots", () => {
    const current = record("Manual", 2, 20);
    expect(mergeCanonicalChatRecord(current, record("Old", 1, 19))).toBe(current);
    expect(mergeCanonicalChatRecord(current, record("Old", 1, 21)).chat).toMatchObject({ title: "Manual", titleVersion: 2, revision: 21 });
  });
  it("applies title responses independently of newer stream revisions", () => {
    expect(mergeCanonicalChatRecord(record("Old", 1, 30), record("Manual", 2, 25)).chat)
      .toMatchObject({ title: "Manual", titleVersion: 2, revision: 30 });
  });
  it("sorts only by user activity with deterministic id ties", () => {
    const a = record("A", 1, 10);
    const b = { ...record("B", 9, 100), chat: { ...record("B", 9, 100).chat, id: "chat_b", updatedAt: "2027-01-01T00:00:00.000Z" } };
    expect([b, a].sort(compareCanonicalChatActivity)).toEqual([a, b]);
  });
});
