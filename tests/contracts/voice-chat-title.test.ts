import { describe, expect, it } from "vitest";
import { generatedVoiceChatTitle } from "../../packages/contracts/src/generated-chat-title.js";
describe("voice topic titles", () => {
  it("does not strip greetings from inside topic words", () => {
    expect(generatedVoiceChatTitle(["History of Stockholm"])).toBe("History of Stockholm");
    expect(generatedVoiceChatTitle(["Hello Matrix, plan my week"])).toBe("Plan my week");
  });
  it("skips small talk and bounds the opening window and title", () => {
    expect(generatedVoiceChatTitle(["Hi", "Thanks", "How are you", "Plan my week"])).toBeNull();
    expect(generatedVoiceChatTitle(["Research " + "my product launch ".repeat(30)])!.length).toBeLessThanOrEqual(56);
  });
});
