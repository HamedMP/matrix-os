import { expect, it } from "vitest";
import { createBoundedAssistantPreview, ASSISTANT_PREVIEW_TRUNCATED_NOTICE } from "../../packages/gateway/src/chat/bounded-assistant-preview.js";
import { assistantCredentialOccurrenceId, sealAssistantCredential } from "../../packages/gateway/src/chat/assistant-credential-crypto.js";

it("retains complete credential sidecars and cuts before a credential crossing the preview boundary", () => {
  const messageId = "msg_preview";
  const credential = (offset: number) => {
    const occurrenceId = assistantCredentialOccurrenceId(messageId, offset);
    return { occurrenceId, offset, length: 21 as const, envelope: sealAssistantCredential(Buffer.alloc(32, 7), {
      ownerId: "owner_preview", chatId: "chat_preview", runId: "run_preview", messageId, occurrenceId,
    }, "fake-private-secret") };
  };
  const preview = createBoundedAssistantPreview({ maxEncodedBytes: 128 });
  const retained = credential(1);
  expect(preview.append({ messageId, delta: "a[redacted credential]", credentials: [retained] })?.credentials).toEqual([retained]);
  const crossing = credential(50);
  const truncated = preview.append({ messageId, delta: `${"b".repeat(50)}[redacted credential]tail`, credentials: [crossing] });
  expect(truncated?.delta).toBe("b".repeat(50) + ASSISTANT_PREVIEW_TRUNCATED_NOTICE);
  expect(truncated?.credentials).toBeUndefined();
  expect(JSON.stringify(truncated)).not.toContain("fake-private-secret");
  expect(preview.append({ messageId, delta: "late text", credentials: [crossing] })).toBeUndefined();
});

it("bounds JSON escapes and never cuts an emoji between surrogate halves", () => {
  const preview = createBoundedAssistantPreview({ maxEncodedBytes: 128 });
  const output = preview.append({ messageId: "msg_unicode", delta: `x${"\n😀".repeat(100)}` })!;
  expect(Buffer.byteLength(JSON.stringify(output.delta)) - 2).toBeLessThanOrEqual(128);
  const prefix = output.delta.slice(0, -ASSISTANT_PREVIEW_TRUNCATED_NOTICE.length);
  expect(prefix).not.toMatch(/[\uD800-\uDBFF]$/u);
  expect(output.delta.match(/Output preview truncated/g)).toHaveLength(1);
});

it("keeps a bounded set of message identities and places one notice in the last retained message", () => {
  const preview = createBoundedAssistantPreview({ maxMessages: 2 });
  preview.append({ messageId: "msg_first", delta: "first" });
  preview.append({ messageId: "msg_second", delta: "second" });
  expect(preview.append({ messageId: "msg_third", delta: "third" })).toEqual({ messageId: "msg_second", delta: ASSISTANT_PREVIEW_TRUNCATED_NOTICE });
  expect(preview.append({ messageId: "msg_fourth", delta: "fourth" })).toBeUndefined();
});
