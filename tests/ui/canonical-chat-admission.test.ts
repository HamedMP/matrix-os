import { createChatMentionRequestTracker } from "../../packages/ui/src/chat-agents/request-tracker";
import { describe, expect, it, vi } from "vitest";
import { createCanonicalChatAdmissionTracker, ChatAdmissionUnconfirmed } from "../../packages/ui/src/canonical-chat-admission";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { CanonicalChatTurnAdmissionResponseSchema } from "@matrix-os/contracts";

function fixture() {
  const { snapshot } = createCanonicalChatFixture("completed");
  const { project, providerBinding, activeRun, ...chat } = snapshot.chat;
  const detail = { record: { chat, projectId: project?.id, providerBinding, activeRun }, messages: snapshot.messages,
    turns: snapshot.turns, runs: snapshot.runs, activities: snapshot.activities };
  const tracker = createCanonicalChatAdmissionTracker();
  const input = { parts: [{ type: "text" as const, text: "one explicit message" }], selection: snapshot.runs[0]!.selection,
    interactionMode: "default", permissionMode: "supervised" };
  const attempt = tracker.prepare("runtime-a", chat.id, input, snapshot.turns[0]!.clientRequestId);
  tracker.bind(attempt, detail.record);
  return { detail, tracker, attempt, input };
}

describe("canonical Chat admission confirmation", () => {
  it("requires exact runtime, request, linked user message and first run even after completion", async () => {
    const f = fixture();
    const accepted = vi.fn();
    const post = vi.fn(async () => { throw new Error("response lost"); });
    await expect(f.tracker.send(f.attempt, { post, read: async () => ({ ...f.detail, turns: [] }),
      current: () => null, isCurrent: () => true, onAccepted: accepted, definitive: () => false })).rejects.toBeInstanceOf(ChatAdmissionUnconfirmed);
    f.tracker.observe("runtime-b", f.detail);
    f.tracker.observe("runtime-a", { ...f.detail, turns: f.detail.turns.map(turn => ({ ...turn, clientRequestId: "req_other" })) });
    f.tracker.observe("runtime-a", { ...f.detail, messages: [] });
    f.tracker.observe("runtime-a", { ...f.detail, runs: [] });
    expect(accepted).not.toHaveBeenCalled();
    f.tracker.observe("runtime-a", f.detail);
    f.tracker.observe("runtime-a", f.detail);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("resolves from a receipt before a late HTTP timeout and never acknowledges twice", async () => {
    const f = fixture();
    let fail!: (error: Error) => void;
    const accepted = vi.fn();
    const read = vi.fn(async () => f.detail);
    const result = f.tracker.send(f.attempt, { post: () => new Promise((_resolve, reject) => { fail = reject; }),
      read, current: () => null, isCurrent: () => true, onAccepted: accepted, definitive: () => false });
    f.tracker.observe("runtime-a", f.detail);
    expect(await result).toMatchObject({ admission: "already_accepted" });
    fail(new Error("late timeout"));
    await Promise.resolve();
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps the exact original body and callback across explicit ambiguous retries", async () => {
    const f = fixture();
    const original = JSON.parse(JSON.stringify(f.attempt.request));
    const accepted = vi.fn();
    const newerDraft = vi.fn();
    const post = vi.fn(async () => { throw new Error("unknown"); });
    const options = { post, read: async () => ({ ...f.detail, turns: [] }), current: () => null,
      isCurrent: () => true, onAccepted: accepted, definitive: () => false };
    await expect(f.tracker.send(f.attempt, options)).rejects.toBeInstanceOf(ChatAdmissionUnconfirmed);
    f.input.parts[0]!.text = "edited after submission";
    await expect(f.tracker.send(f.attempt, { ...options, onAccepted: newerDraft })).rejects.toBeInstanceOf(ChatAdmissionUnconfirmed);
    expect(post.mock.calls.map(call => call[0])).toEqual([original, original]);
    f.tracker.observe("runtime-a", f.detail);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(newerDraft).not.toHaveBeenCalled();
  });

  it("holds capacity without evicting unresolved request identities", () => {
    const f = fixture();
    const original = f.attempt.id;
    for (let index = 1; index < 100; index++) f.tracker.prepare("runtime-a", `chat_${index}`, f.input);
    expect(() => f.tracker.prepare("runtime-a", "chat_overflow", f.input)).toThrow(ChatAdmissionUnconfirmed);
    expect(f.tracker.prepare("runtime-a", f.detail.record.chat.id, f.input, f.detail.turns[0]!.clientRequestId).id).toBe(original);
  });

  it("does not give a changed payload the unresolved earlier draft's supplied id", () => {
    const f = fixture();
    const changed = { ...f.input, selection: { ...f.input.selection, model: "different-model" } };
    const second = f.tracker.prepare("runtime-a", f.detail.record.chat.id, changed, f.attempt.id);
    expect(second.id).not.toBe(f.attempt.id);
    expect(f.tracker.prepare("runtime-a", f.detail.record.chat.id, changed, f.attempt.id)).toBe(second);
  });

  it("does not forget an earlier ambiguous request when an explicit retry is rejected", async () => {
    const f = fixture();
    const post = vi.fn(async () => { throw new Error("unknown original outcome"); });
    const options = { post, read: async () => ({ ...f.detail, turns: [] }), current: () => null,
      isCurrent: () => true, onAccepted: vi.fn(), onRejected: vi.fn(), definitive: () => false };
    await expect(f.tracker.send(f.attempt, options)).rejects.toBeInstanceOf(ChatAdmissionUnconfirmed);
    await expect(f.tracker.send(f.attempt, { ...options, definitive: () => true })).rejects.toBeInstanceOf(ChatAdmissionUnconfirmed);
    expect(f.tracker.prepare("runtime-a", f.detail.record.chat.id, f.input, f.attempt.seed)).toBe(f.attempt);
    expect(options.onRejected).not.toHaveBeenCalled();
  });

  it("releases definitely rejected composer ids so healthy explicit sends do not exhaust capacity", async () => {
    const f = fixture();
    const seeds = createChatMentionRequestTracker();
    const onAccepted = vi.fn();
    for (let index = 0; index < 101; index++) {
      const input = { ...f.input, parts: [{ type: "text" as const, text: `message ${index}` }] };
      const seed = seeds.resolve("runtime-a", f.detail.record.chat.id, input, "send").clientRequestId;
      const attempt = f.tracker.prepare("runtime-a", f.detail.record.chat.id, input, seed);
      f.tracker.bind(attempt, f.detail.record);
      await expect(f.tracker.send(attempt, { post: async () => { throw new Error("rejected"); },
        read: async () => f.detail, current: () => null, isCurrent: () => true, onAccepted,
        onRejected: () => seeds.accepted(f.detail.record.chat.id, seed), definitive: () => true })).rejects.toThrow("rejected");
    }
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it.each(["parts", "seed"])("rejects locally invalid %s before tracking an attempt", field => {
    const f = fixture();
    expect(() => f.tracker.prepare("runtime-a", "chat_invalid", field === "parts" ? { ...f.input, parts: [] } : f.input,
      field === "seed" ? "\u0000invalid" : undefined)).toThrow();
  });

  it("gives an exact current durable receipt precedence over a later rejection", async () => {
    const f = fixture();
    const accepted = vi.fn();
    const result = await f.tracker.send(f.attempt, { post: async () => { throw new Error("HTTP rejection"); },
      read: async () => f.detail, current: () => f.detail, isCurrent: () => true, onAccepted: accepted, definitive: () => true });
    expect(result).toMatchObject({ admission: "already_accepted" });
    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it("keeps a response-schema failure ambiguous because the POST may already be committed", async () => {
    const f = fixture();
    const invalid = CanonicalChatTurnAdmissionResponseSchema.safeParse({});
    const accepted = vi.fn();
    const result = await f.tracker.send(f.attempt, { post: async () => { if (!invalid.success) throw invalid.error; throw new Error("Invalid fixture"); },
      read: async () => f.detail, current: () => null, isCurrent: () => true, onAccepted: accepted, definitive: () => false });
    expect(result).toMatchObject({ admission: "already_accepted" });
    expect(accepted).toHaveBeenCalledTimes(1);
  });
});

it("holds one hundred unknown requests without evicting an earlier draft into a new id", () => {
  const tracker = createChatMentionRequestTracker();
  const owner = {};
  const original = tracker.resolve(owner, "new:global", { text: "original" }, "send");
  for (let index = 1; index < 100; index++) tracker.resolve(owner, "new:global", { text: `draft ${index}` }, "send");
  expect(() => tracker.resolve(owner, "new:global", { text: "overflow" }, "send")).toThrow(ChatAdmissionUnconfirmed);
  expect(tracker.resolve(owner, "new:global", { text: "original" }, "queue")).toEqual(original);
  tracker.accepted("new:global", original.clientRequestId);
  expect(tracker.resolve(owner, "new:global", { text: "overflow" }, "send").clientRequestId).not.toBe(original.clientRequestId);
});
