import { describe, expect, it } from "vitest";
import { buildTranscript } from "../../apps/mobile/lib/canonical-chat-transcript.js";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";

describe("Native Mobile canonical Chat artifact parity", () => {
  it("projects durable assistant attachment references into the transcript", () => {
    const { snapshot } = createCanonicalChatFixture("completed");
    const { providerBinding: _providerBinding, activeRun: _activeRun, project: _project, ...chat } = snapshot.chat;
    const transcript = buildTranscript({
      record: { chat },
      messages: [{
        id: "message_artifact_mobile",
        chatId: chat.id,
        seq: 1,
        role: "assistant",
        purpose: "assistant",
        state: "final",
        createdAt: "2026-09-22T12:00:01.000Z",
        parts: [{
          type: "attachment_reference",
          attachmentId: "attachment_mobile_whale",
          kind: "image",
          label: "whale.png",
          mimeType: "image/png",
          sizeBytes: 8,
          ownerReference: "data/chat-artifacts/codex/sha256/whale.png",
          resource: { kind: "home", path: "data/chat-artifacts/codex/sha256/whale.png" },
        }],
      }],
      turns: [], runs: [], activities: [], queuedTurns: [],
    } as never);

    expect(transcript[0]?.attachments).toEqual([{
      id: "attachment_mobile_whale",
      kind: "image",
      label: "whale.png",
      path: "data/chat-artifacts/codex/sha256/whale.png",
      mimeType: "image/png",
      sizeBytes: 8,
    }]);
  });
});
