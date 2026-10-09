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

  it("keeps dates and slash words whole, as only repository paths are shortened", () => {
    expect(generatedChatTitle("What changed between 10/01/2026 and 10/08/2026 in our deploy pipeline config"))
      .toBe("What changed between 10/01/2026 and 10/08/2026 in our\u2026");
    expect(generatedChatTitle("Compare REST/GraphQL and client/server tradeoffs for the new sync API before we pick one"))
      .toBe("Compare REST/GraphQL and client/server tradeoffs for\u2026");
    expect(generatedChatTitle("Should we run an A/B test on the onboarding flow and/or the pricing page this quarter"))
      .toBe("Should we run an A/B test on the onboarding flow\u2026");
    // A path followed by a comma is still a path.
    expect(generatedChatTitle("Why did packages/ui/src/brain/BrainChat.tsx, and its tests, change in this week's work?"))
      .toBe("Why did BrainChat.tsx, and its tests, change in this\u2026");
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
