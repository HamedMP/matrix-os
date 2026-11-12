import { expect, it } from "vitest";
import { appendSideChatAnswer } from "../../shell/src/components/chat/side-chat-draft";

it("keeps an unsent main chat draft when a side answer is copied", () => {
  expect(appendSideChatAnswer("My unfinished thought", "Side answer"))
    .toBe("My unfinished thought\n\nSide answer");
  expect(appendSideChatAnswer("", "Side answer")).toBe("Side answer");
});
