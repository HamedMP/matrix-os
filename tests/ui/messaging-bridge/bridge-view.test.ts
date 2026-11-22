import { describe, expect, it } from "vitest";
import {
  chatAccountLabel,
  deriveChatAppsSection,
  deriveThreadEntries,
  mergeRefreshedConversations,
  mergeRefreshedMessages,
  filterConversations,
  linkFailureMessage,
  mergeConversations,
  mergeMessages,
  needsUnofficialWarning,
  retryableFailure,
} from "../../../packages/ui/src/messaging/bridge-view";
import { conversation, message, readyWithAccounts, status } from "./fixtures";

describe("chat apps section state", () => {
  it("prefers loading, then error, then availability", () => {
    expect(deriveChatAppsSection({ status: null, loading: true, error: null })).toEqual({ kind: "loading" });
    expect(deriveChatAppsSection({ status: readyWithAccounts(), loading: false, error: "Try again." })).toEqual({ kind: "error", message: "Try again." });
    expect(deriveChatAppsSection({ status: status({ availability: "not_enabled", networks: [] }), loading: false, error: null }).kind).toBe("not_enabled");
    expect(deriveChatAppsSection({ status: status({ availability: "unavailable", networks: [] }), loading: false, error: null }).kind).toBe("unavailable");
  });

  it("builds one row per offered network with its account states and action", () => {
    const state = deriveChatAppsSection({ status: readyWithAccounts(), loading: false, error: null });
    if (state.kind !== "ready") throw new Error(`expected ready, got ${state.kind}`);
    expect(state.hasAccounts).toBe(true);
    expect(state.rows.map((row) => [row.label, row.action, row.accounts.map((a) => [a.label, a.stateLabel])])).toEqual([
      ["WhatsApp", null, [["+46 70 000 0000", "Connected"]]],
      ["Telegram", "reconnect", [["Telegram account", "Needs reconnecting"]]],
      ["LinkedIn", "connect", []],
    ]);
  });

  it("omits networks the owner is not offered and keeps contract order", () => {
    const state = deriveChatAppsSection({
      status: status({ availability: "ready", networks: [{ network: "linkedin", accounts: [] }, { network: "whatsapp", accounts: [] }] }),
      loading: false,
      error: null,
    });
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.rows.map((row) => row.network)).toEqual(["whatsapp", "linkedin"]);
    expect(state.hasAccounts).toBe(false);
  });
});

describe("labels and copy", () => {
  it("labels accounts by display name, falling back to the network", () => {
    expect(chatAccountLabel("linkedin", { accountId: "li", displayName: "Grace Hopper", state: "connected" })).toBe("Grace Hopper");
    expect(chatAccountLabel("linkedin", { accountId: "li", displayName: "  ", state: "connected" })).toBe("LinkedIn account");
  });

  it("warns before unofficial WhatsApp and LinkedIn links only", () => {
    expect([needsUnofficialWarning("whatsapp"), needsUnofficialWarning("linkedin"), needsUnofficialWarning("telegram")]).toEqual([true, true, false]);
  });

  it("has a plain retry message for every failure reason", () => {
    for (const reason of ["expired", "rejected", "bridge_unavailable", "unknown"] as const) {
      expect(linkFailureMessage(reason)).toMatch(/try again/i);
    }
    expect(linkFailureMessage("expired")).not.toBe(linkFailureMessage("rejected"));
  });
});

describe("conversation helpers", () => {
  const a = conversation({ roomId: "!a:x", network: "whatsapp", lastEventAt: "2026-11-22T10:00:00.000Z" });
  const b = conversation({ roomId: "!b:x", network: "telegram", lastEventAt: "2026-11-22T11:00:00.000Z" });
  const c = conversation({ roomId: "!c:x", network: "linkedin" });

  it("filters by network", () => {
    expect(filterConversations([a, b, c], "all")).toEqual([a, b, c]);
    expect(filterConversations([a, b, c], "telegram")).toEqual([b]);
  });

  it("merges a refreshed page into loaded pages, newest first, without duplicates", () => {
    const updatedA = { ...a, lastEventAt: "2026-11-22T12:00:00.000Z", unreadCount: 2 };
    expect(mergeConversations([b, a, c], [updatedA]).map((x) => [x.roomId, x.unreadCount])).toEqual([["!a:x", 2], ["!b:x", 0], ["!c:x", 0]]);
  });
});

describe("thread helpers", () => {
  const m1 = message({ eventId: "$1", occurredAt: "2026-11-22T10:00:00.000Z" });
  const m2 = message({ eventId: "$2", occurredAt: "2026-11-22T10:01:00.000Z" });
  const m3 = message({ eventId: "$3", occurredAt: "2026-11-22T10:02:00.000Z", direction: "outgoing" });

  it("orders messages oldest to newest and dedupes by identity", () => {
    expect(mergeMessages([m3, m2], [m2, m1]).map((m) => m.eventId)).toEqual(["$1", "$2", "$3"]);
  });

  it("replaces a sending copy with its delivered copy through the shared clientTxnId", () => {
    const sending = message({ clientTxnId: "txn-00000001", direction: "outgoing", delivery: "sending", body: "hi", occurredAt: "2026-11-22T10:03:00.000Z" });
    const delivered = { ...sending, eventId: "$4", delivery: "sent" as const };
    expect(mergeMessages([m1, sending], [delivered])).toEqual([m1, delivered]);
  });

  it("lets a local send yield to the server copy, except while retrying a server-recorded failure", () => {
    const serverSent = message({ clientTxnId: "txn-sent-0001", eventId: "$5", direction: "outgoing", delivery: "sent", body: "sent one" });
    const serverFailed = message({ clientTxnId: "txn-fail-0001", direction: "outgoing", delivery: "failed", body: "failed one", occurredAt: "2026-11-22T10:04:00.000Z" });
    const entries = deriveThreadEntries([m1, serverSent, serverFailed], [
      { clientTxnId: "txn-sent-0001", body: "sent one", state: "sending", createdAt: "2026-11-22T10:02:00.000Z" },
      { clientTxnId: "txn-fail-0001", body: "failed one", state: "sending", createdAt: "2026-11-22T10:04:00.000Z" },
      { clientTxnId: "txn-local-001", body: "new", state: "failed", createdAt: "2026-11-22T10:05:00.000Z" },
    ]);
    expect(entries.map((e) => (e.kind === "message" ? `server:${e.message.body}` : `local:${e.pending.body}:${e.pending.state}`))).toEqual([
      "server:hello",
      "server:sent one",
      "local:failed one:sending",
      "local:new:failed",
    ]);
  });

  it("keeps a failed local send in its place when a newer reply arrives", () => {
    const reply = message({ eventId: "$reply", occurredAt: "2026-11-22T10:05:00.000Z", body: "later reply" });
    const entries = deriveThreadEntries([m1, reply], [
      { clientTxnId: "txn-fail-0002", body: "my failed send", state: "failed", createdAt: "2026-11-22T10:03:00.000Z" },
    ]);
    expect(entries.map((e) => (e.kind === "message" ? e.message.body : e.pending.body))).toEqual(["hello", "my failed send", "later reply"]);
  });

  it("replaces loaded history and its cursor when a refreshed page does not reach it", () => {
    const loaded = { items: [m1, m2], nextCursor: "c-old" };
    const newer = Array.from({ length: 3 }, (_unused, index) => message({ eventId: `$n${index}`, occurredAt: `2026-11-22T11:0${index}:00.000Z` }));
    // More arrived than one page holds: the page does not overlap, so keeping c-old would skip the gap.
    expect(mergeRefreshedMessages(loaded, { items: newer, nextCursor: "c-gap" })).toEqual({ items: newer, nextCursor: "c-gap" });
    // Overlapping page: merged, and the cursor of the older loaded history is kept.
    expect(mergeRefreshedMessages(loaded, { items: [m2, m3], nextCursor: "c-page" })).toEqual({ items: [m1, m2, m3], nextCursor: "c-old" });
    // A page that reaches the start of history has no cursor and still merges.
    expect(mergeRefreshedMessages(loaded, { items: [m3] }).items).toEqual([m1, m2, m3]);
  });

  it("replaces loaded conversations and their cursor when a refreshed page one does not reach them", () => {
    const old = Array.from({ length: 3 }, (_unused, index) => conversation({ roomId: `!old${index}:x`, lastEventAt: `2026-11-22T09:0${index}:00.000Z` }));
    const fresh = Array.from({ length: 2 }, (_unused, index) => conversation({ roomId: `!new${index}:x`, lastEventAt: `2026-11-22T11:0${index}:00.000Z` }));
    // More conversations became active than page one holds: reset, then page again from its cursor.
    expect(mergeRefreshedConversations({ items: old, nextCursor: "3" }, { items: fresh, nextCursor: "2" })).toEqual({ items: fresh, nextCursor: "2" });
    // A fully loaded list (no cursor) gets its cursor back instead of losing the gap.
    expect(mergeRefreshedConversations({ items: old }, { items: fresh, nextCursor: "2" })).toEqual({ items: fresh, nextCursor: "2" });
    // Overlapping page one: merged, and the cursor of later loaded pages is kept.
    const overlapping = mergeRefreshedConversations({ items: old, nextCursor: "3" }, { items: [fresh[0]!, old[2]!] });
    expect(overlapping.items.map((item) => item.roomId)).toEqual(["!new0:x", "!old2:x", "!old1:x", "!old0:x"]);
    expect(overlapping.nextCursor).toBe("3");
  });

  it("offers retry only for outgoing Matrix sends the server recorded as failed", () => {
    const failed = message({ clientTxnId: "txn-fail-0001", direction: "outgoing", delivery: "failed", body: "again" });
    expect(retryableFailure(failed)).toEqual({ clientTxnId: "txn-fail-0001", body: "again", state: "failed", createdAt: failed.occurredAt });
    expect(retryableFailure({ ...failed, delivery: "sent" })).toBeNull();
    expect(retryableFailure(message({ eventId: "$6", direction: "outgoing", delivery: "failed" }))).toBeNull();
  });
});
