import { describe, expect, it } from "vitest";
import { parseAddressList } from "../../../../home/apps/_shared/office-accounts/mail/addresses";
import { MESSAGE_CACHE_CHARS, createMessageCache } from "../../../../home/apps/_shared/office-accounts/mail/provider-options";
import { LruCache, decodeCursor, mapLimit } from "../../../../home/apps/_shared/office-accounts/mail/support";
import { decodeEncodedWords, htmlToText } from "../../../../home/apps/_shared/office-accounts/mail/text";
import type { MailMessage } from "../../../../home/apps/_shared/office-accounts/types/mail";

function message(id: string, chars: number): MailMessage {
  return {
    id, threadId: "t", from: { address: "a@b.co" }, to: [], cc: [], bcc: [], sentAt: "2025-01-01T00:00:00Z", subject: "",
    bodyText: "x".repeat(chars), bodyHtml: null, attachments: [], messageIdHeader: null, references: [],
  };
}

describe("LruCache", () => {
  it("evicts the least recently used entry by count and by weight", () => {
    const cache = new LruCache<string, string>(3, 10, (value) => value.length);
    cache.set("a", "1111");
    cache.set("b", "2222");
    expect(cache.get("a")).toBe("1111");
    cache.set("c", "333");
    expect(cache.has("b")).toBe(false);
    expect([cache.size, cache.weight]).toEqual([2, 7]);
    cache.set("huge", "x".repeat(11));
    expect(cache.has("huge")).toBe(false);
    cache.set("d", "4"); cache.set("e", "5");
    expect(cache.size).toBe(3);
    expect(cache.has("a")).toBe(false);
  });

  it("caps the message body cache by total characters", () => {
    const cache = createMessageCache();
    const third = Math.floor(MESSAGE_CACHE_CHARS / 3);
    for (const id of ["m1", "m2", "m3", "m4"]) cache.set(id, message(id, third));
    expect(cache.has("m1")).toBe(false);
    expect(cache.has("m4")).toBe(true);
    expect(cache.weight).toBeLessThanOrEqual(MESSAGE_CACHE_CHARS);
  });
});

describe("mapLimit and cursors", () => {
  it("keeps order and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (value) => {
      running++; peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, value));
      running--;
      return value * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  it("rejects foreign and malformed cursors", () => {
    expect(decodeCursor(undefined, ["g"])).toBeNull();
    expect(decodeCursor("g.abc", ["g"])).toEqual({ kind: "g", value: "abc" });
    for (const bad of ["s.abc", "g.", "g.a b", "nodot"]) expect(() => decodeCursor(bad, ["g"])).toThrow(expect.objectContaining({ code: "not_supported" }));
  });
});

describe("header and body text", () => {
  it("parses quoted, commented and grouped address lists", () => {
    expect(parseAddressList("\"Doe, Jane\" <Jane@X.org>, bob@x.org (Bob), Team: c@x.org, d@x.org;, junk")).toEqual([
      { name: "Doe, Jane", address: "jane@x.org" },
      { name: "Bob", address: "bob@x.org" },
      { address: "c@x.org" },
      { address: "d@x.org" },
    ]);
  });

  it("decodes encoded words and turns hostile HTML into plain text", () => {
    expect(decodeEncodedWords("=?ISO-8859-1?Q?Caf=E9?= =?UTF-8?B?4pyT?=")).toBe("Café✓");
    expect(htmlToText("<style>p{}</style><p>One&nbsp;&amp;</p><!-- x --><script>bad()</script><div>Two</div>")).toBe("One &\n\nTwo");
  });
});
