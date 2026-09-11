import { describe, expect, it } from "@jest/globals";
import { isSafeChatLink } from "@/lib/chat-markdown";

describe("chat markdown links", () => {
  it.each(["https://matrix-os.com", "http://example.com", "mailto:hello@example.com"])(
    "allows an explicitly supported external URL: %s",
    (url) => expect(isSafeChatLink(url)).toBe(true),
  );

  it.each(["javascript:alert(1)", "file:///home/matrix/private", "/files/private", "data:text/html,test"])(
    "keeps an unsafe or owner-local destination inert: %s",
    (url) => expect(isSafeChatLink(url)).toBe(false),
  );
});
