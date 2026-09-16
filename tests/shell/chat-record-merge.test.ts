import { describe, expect, it } from "vitest";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { mergeCanonicalChatRecord, compareCanonicalChatActivity } from "../../packages/ui/src/canonical-chat-record";
const record = (title: string, titleVersion: number, revision: number, activityAt = "2026-09-01T00:00:00.000Z") => ({
  chat: { id: "chat_a", title, titleVersion, revision, activityAt, createdAt: activityAt, updatedAt: activityAt },
}) as CanonicalChatRecord;
describe("canonical Chat metadata reconciliation", () => {
  it("reconciles title and read-state versions independently of transcript revisions", () => {
    const current = { ...record("Manual", 2, 20), readState: {
      version: 3, readThroughSeq: 5, latestIncomingSeq: 5, markedUnread: true, unread: true,
    } };
    const incoming = { ...record("Old", 1, 21), readState: {
      version: 2, readThroughSeq: 4, latestIncomingSeq: 6, markedUnread: false, unread: true,
    } };
    const merged = mergeCanonicalChatRecord(current, incoming);
    expect(merged.chat).toMatchObject({ title: "Manual", titleVersion: 2, revision: 21 });
    expect(merged.readState).toMatchObject({ version: 3, markedUnread: true, latestIncomingSeq: 6 });
    expect(mergeCanonicalChatRecord(merged, { ...current, readState: {
      ...current.readState, version: 4, readThroughSeq: 6, latestIncomingSeq: 6, markedUnread: false, unread: false,
    } }).readState).toMatchObject({ version: 4, unread: false });
  });
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
