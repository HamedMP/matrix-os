import { describe, expect, it } from "vitest";
import { createAssistantTextStreamProjector, projectAssistantTextWithCaptures, sanitizeAssistantText } from "../../packages/gateway/src/chat/safe-activity-projection.js";
import {
  openAssistantCredential,
  sealAssistantCredential,
} from "../../packages/gateway/src/chat/assistant-credential-crypto.js";
import { createAssistantCredentialEmitter } from "../../packages/gateway/src/chat/assistant-credential-emitter.js";

const options = { homePath: "/home/matrix/home", showPrivatePaths: true };
const binding = {
  ownerId: "user_1", chatId: "chat_1", runId: "run_1",
  messageId: "msg_1", occurrenceId: "cred_1",
};

describe("private assistant credential capture", () => {
  it("keeps a split assignment masked while capturing only the completed value", () => {
    const projector = createAssistantTextStreamProjector(options);
    expect(projector.pushCaptured("API_")).toEqual({ text: "", captures: [] });
    expect(projector.pushCaptured("KEY = sk-live-123")).toEqual({ text: "", captures: [] });
    const result = projector.pushCaptured(" end");
    expect(result.text).toBe("[redacted credential] ");
    expect(result.captures).toEqual([{ offset: 0, length: 21, value: "sk-live-123" }]);
    expect(projector.flushCaptured()).toEqual({ text: "end", captures: [] });
  });

  it("captures multiple values with UTF-16 safe offsets", () => {
    const projector = createAssistantTextStreamProjector(options);
    const result = projector.pushCaptured("😀 Bearer abc123 API_KEY=xyz456 ");
    expect(result.text).toBe("😀 Bearer [redacted] [redacted credential] ");
    expect(result.captures.map(({ offset, length, value }) => ({ offset, length, value }))).toEqual([
      { offset: 10, length: 10, value: "abc123" },
      { offset: 21, length: 21, value: "xyz456" },
    ]);
  });

  it("does not capture oversized tokens", () => {
    const projector = createAssistantTextStreamProjector(options);
    const result = projector.pushCaptured(`API_KEY=${"x".repeat(2_200)} `);
    expect(result.captures).toEqual([]);
    expect(result.text).toContain("[redacted]");
  });

  it.each([
    "API_KEY=Bearer abc", "Bearer API_KEY=abc", "Bearer bearer xyz", "SECRET=abc PASSWORD=def",
    "😀 ACCESS_TOKEN=机密值", "API_KEY=/home/matrix/home?token=abc",
  ])("keeps exact legacy masked projection for overlapping input %s", (raw) => {
    for (const showPrivatePaths of [true, false]) {
      const projection = { ...options, showPrivatePaths };
      const captured = projectAssistantTextWithCaptures(raw, projection);
      expect(captured.text).toBe(sanitizeAssistantText(raw, projection));
      for (const capture of captured.captures) {
        expect(captured.text.slice(capture.offset, capture.offset + capture.length))
          .toMatch(/^\[redacted(?: credential)?\]$/);
      }
    }
  });

  it("keeps nested split credentials masked without publishing the suffix", () => {
    const projector = createAssistantTextStreamProjector(options);
    const chunks = ["API_KEY=Bear", "er abc", " done"];
    const result = chunks.map((chunk) => projector.pushCaptured(chunk));
    result.push(projector.flushCaptured());
    expect(result.map((part) => part.text).join("")).toBe(sanitizeAssistantText(chunks.join(""), options));
    expect(JSON.stringify(result)).not.toContain('"value":"abc"');
  });

  it("seals with owner and message binding, rejecting wrong context and malformed envelopes", () => {
    const key = Buffer.alloc(32, 7);
    const envelope = sealAssistantCredential(key, binding, "abc123");
    expect(JSON.stringify(envelope)).not.toContain("abc123");
    expect(openAssistantCredential(key, binding, envelope)).toBe("abc123");
    expect(() => openAssistantCredential(key, { ...binding, messageId: "msg_2" }, envelope)).toThrow();
    expect(() => openAssistantCredential(key, binding, { ...envelope, data: "!!!" })).toThrow();
    expect(() => sealAssistantCredential(key, binding, "x".repeat(2_049))).toThrow();
  });

  it("emits sealed sidecars at safe delta offsets and masks when a key is unavailable", () => {
    const projector = createAssistantTextStreamProjector(options);
    const projected = projector.pushCaptured("API_KEY=abc123 ");
    const key = Buffer.alloc(32, 7);
    const emitter = createAssistantCredentialEmitter({ ownerType: "personal", ownerId: "user_1", chatId: "chat_1", runId: "run_1", key });
    const events = emitter.emit(projected);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.type).toBe("assistant.delta");
    if (event?.type !== "assistant.delta") return;
    expect(event.delta).toBe("[redacted credential] ");
    expect(event.credentials).toHaveLength(1);
    const credential = event.credentials![0]!;
    expect(credential.offset).toBe(0);
    expect(openAssistantCredential(key, { ...binding, messageId: "msg_1_assistant", occurrenceId: credential.occurrenceId }, credential.envelope)).toBe("abc123");
    expect(JSON.stringify(event)).not.toContain("abc123");
    const unavailable = createAssistantCredentialEmitter({ ownerType: "personal", ownerId: "user_1", chatId: "chat_1", runId: "run_1" }).emit(projected)[0];
    expect(unavailable).toMatchObject({ type: "assistant.delta", delta: "[redacted credential] " });
    expect(unavailable && "credentials" in unavailable).toBe(false);
  });

  it("does not seal owner-only sidecars for organization runs", () => {
    const projected = projectAssistantTextWithCaptures("API_KEY=abc123 ", options);
    const events = createAssistantCredentialEmitter({
      ownerType: "organization", ownerId: "org_1", chatId: "chat_1", runId: "run_1", key: Buffer.alloc(32, 7),
    }).emit(projected);
    expect(events).toMatchObject([{ type: "assistant.delta", delta: "[redacted credential] " }]);
    expect(events[0] && "credentials" in events[0]).toBe(false);
  });

  it("caps capture at 16 per message without losing masked output", () => {
    const raw = Array.from({ length: 18 }, (_, index) => `API_KEY=value${index} `).join("");
    const projector = createAssistantTextStreamProjector(options);
    const projected = projector.pushCaptured(raw);
    const emitter = createAssistantCredentialEmitter({ ownerType: "personal", ownerId: "user_1", chatId: "chat_1", runId: "run_1", key: Buffer.alloc(32, 7) });
    const events = emitter.emit(projected);
    expect(events.filter((event) => event.type === "assistant.delta").flatMap((event) => event.type === "assistant.delta" ? event.credentials ?? [] : [])).toHaveLength(16);
    expect(events.filter((event) => event.type === "assistant.delta").map((event) => event.type === "assistant.delta" ? event.delta : "").join(""))
      .toBe("[redacted credential] ".repeat(18));
    expect(JSON.stringify(events)).not.toContain("value17");
  });

  it("uses stable occurrence IDs from cumulative safe text offsets", () => {
    const key = Buffer.alloc(32, 7);
    const project = (raw: string) => projectAssistantTextWithCaptures(raw, options);
    const newEmitter = () => createAssistantCredentialEmitter({ ownerType: "personal", ownerId: "user_1", chatId: "chat_1", runId: "run_1", key });
    const first = newEmitter();
    const firstEvents = [
      ...first.emit(project("😀 intro ")),
      ...first.emit(project("API_KEY=first ")),
      ...first.emit(project("API_KEY=second ")),
    ];
    const replay = newEmitter();
    const replayEvents = [
      ...replay.emit(project("😀 intro ")),
      ...replay.emit(project("API_KEY=first ")),
      ...replay.emit(project("API_KEY=second ")),
    ];
    const ids = (events: typeof firstEvents) => events.flatMap((event) => event.type === "assistant.delta"
      ? (event.credentials ?? []).map((credential) => credential.occurrenceId) : []);
    expect(ids(firstEvents)).toHaveLength(2);
    expect(ids(firstEvents)).toEqual(ids(replayEvents));
    expect(new Set(ids(firstEvents)).size).toBe(2);
  });
});
