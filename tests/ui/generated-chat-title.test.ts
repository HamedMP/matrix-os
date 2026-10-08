import { describe, expect, it } from "vitest";
import { generatedChatTitle } from "../../packages/ui/src/generated-chat-title.js";

describe("generated chat titles", () => {
  it("names a long path by its last part, so path questions stay apart in a chat list", () => {
    expect(generatedChatTitle("Why did packages/gateway/src/chat/matrix-sdk-retirement.ts change?"))
      .toBe("Why did matrix-sdk-retirement.ts change");
    expect(generatedChatTitle("Why is packages/ui/src/brain/BrainChat.tsx there and who decided on its layout?"))
      .toBe("Why is BrainChat.tsx there and who decided on its layout");
    // A title that fits keeps its paths whole.
    expect(generatedChatTitle("Why did src/a.ts change?")).toBe("Why did src/a.ts change");
  });

  it("keeps the cut start of a long word instead of dropping almost all of the title", () => {
    const title = generatedChatTitle(`Why is ${"x".repeat(80)} here?`);
    expect(title).toBe(`Why is ${"x".repeat(48)}\u2026`);
    expect(title.length).toBeLessThanOrEqual(56);
  });

  it("still ends on a whole word in ordinary text and leaves web links whole", () => {
    expect(generatedChatTitle("Review today's messages and tasks, then write a short summary for the whole team"))
      .toBe("Review today's messages and tasks, then write a short\u2026");
    expect(generatedChatTitle("What did https://github.com/owner/repo/pull/2299 change in the sidebar code?"))
      .toBe("What did https://github.com/owner/repo/pull/2299\u2026");
  });
});
