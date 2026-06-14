import { describe, expect, it } from "vitest";
import { canSubmitChatDraft } from "@desktop/renderer/src/features/chat/ChatTab";

describe("canSubmitChatDraft", () => {
  it("allows non-empty drafts only while Hermes is idle", () => {
    expect(canSubmitChatDraft("build this", "idle")).toBe(true);
    expect(canSubmitChatDraft("build this", "thinking")).toBe(false);
    expect(canSubmitChatDraft("build this", "streaming")).toBe(false);
  });

  it("rejects empty and whitespace-only drafts", () => {
    expect(canSubmitChatDraft("", "idle")).toBe(false);
    expect(canSubmitChatDraft("   ", "idle")).toBe(false);
  });
});
