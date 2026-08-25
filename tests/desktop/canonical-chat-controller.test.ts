import { describe, expect, it } from "vitest";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { deriveCanonicalChatController } from "../../desktop/src/renderer/src/features/chat/canonical-chat-controller";

describe("canonical active Chat controller", () => {
  it.each([
    ["idle", "draft", true, false],
    ["running", "running", false, true],
    ["approval_required", "waiting_for_approval", false, true],
    ["input_required", "waiting_for_input", false, true],
    ["failed", "failed", true, false],
    ["completed", "ready", true, false],
    ["aborted", "ready", true, false],
    ["archived", "archived", false, false],
  ] as const)("derives %s fixture behavior", (fixtureState, phase, canSubmit, canAbort) => {
    const { snapshot } = createCanonicalChatFixture(fixtureState);

    expect(deriveCanonicalChatController(snapshot)).toMatchObject({
      chatId: snapshot.chat.id,
      projectId: "matrix-os",
      phase,
      instanceLocked: fixtureState !== "idle",
      canSubmit,
      canAbort,
    });
  });
});
