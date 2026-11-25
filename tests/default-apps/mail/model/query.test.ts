import { describe, expect, it } from "vitest";
import {
  isEmptyQuery,
  matchesQuery,
  parseMailQuery,
  toProviderQuery,
} from "../../../../home/apps/mail/src/model/query";
import { summary } from "./fixtures";

describe("parseMailQuery", () => {
  it("splits operators from free text and keeps quoted phrases together", () => {
    const query = parseMailQuery('from:alice subject:"q3 report" has:attachment is:unread budget plan');
    expect(query.from).toEqual(["alice"]);
    expect(query.subject).toEqual(["q3 report"]);
    expect(query.hasAttachment).toBe(true);
    expect(query.unread).toBe(true);
    expect(query.text).toEqual(["budget", "plan"]);
  });

  it("parses dates in the given zone as the start of that day", () => {
    const query = parseMailQuery("after:2026-11-01 before:2026/11/20", { timeZone: "Europe/Berlin" });
    expect(query.after).toBe("2026-11-01T00:00:00+01:00");
    expect(query.before).toBe("2026-11-20T00:00:00+01:00");
  });

  it("treats invalid dates and unknown operators as free text", () => {
    const query = parseMailQuery("before:2026-02-31 label:work");
    expect(query.before).toBeNull();
    expect(query.text).toEqual(["before:2026-02-31", "label:work"]);
  });

  it("reads is:read, is:flagged and is:starred, and lower-cases values", () => {
    const query = parseMailQuery("is:read is:starred TO:Bob@Example.com");
    expect(query.unread).toBe(false);
    expect(query.flagged).toBe(true);
    expect(query.to).toEqual(["bob@example.com"]);
  });

  it("is empty for blank input and bounds the number of terms", () => {
    expect(isEmptyQuery(parseMailQuery("   "))).toBe(true);
    const many = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
    expect(parseMailQuery(many).text.length).toBeLessThanOrEqual(32);
  });

  it("keeps an unterminated quote as one phrase", () => {
    expect(parseMailQuery('subject:"weekly sync').subject).toEqual(["weekly sync"]);
  });
});

describe("matchesQuery", () => {
  const thread = summary("t1", {
    subject: "Q3 report draft",
    snippet: "Numbers attached for review",
    participants: [{ name: "Alice Smith", address: "alice@example.com" }, { address: "me@example.com" }],
    unread: true,
    hasAttachments: true,
    lastMessageAt: "2026-11-10T09:00:00Z",
  });

  it("matches sender, subject, snippet and flags", () => {
    expect(matchesQuery(thread, parseMailQuery("from:alice"))).toBe(true);
    expect(matchesQuery(thread, parseMailQuery("from:smith"))).toBe(true);
    expect(matchesQuery(thread, parseMailQuery("from:bob"))).toBe(false);
    expect(matchesQuery(thread, parseMailQuery('subject:"q3 report"'))).toBe(true);
    expect(matchesQuery(thread, parseMailQuery("review"))).toBe(true);
    expect(matchesQuery(thread, parseMailQuery("has:attachment is:unread"))).toBe(true);
    expect(matchesQuery(thread, parseMailQuery("is:read"))).toBe(false);
    expect(matchesQuery(thread, parseMailQuery("is:flagged"))).toBe(false);
  });

  it("applies date ranges by the moment", () => {
    expect(matchesQuery(thread, parseMailQuery("after:2026-11-10"))).toBe(true);
    expect(matchesQuery(thread, parseMailQuery("after:2026-11-11"))).toBe(false);
    expect(matchesQuery(thread, parseMailQuery("before:2026-11-10"))).toBe(false);
    expect(matchesQuery(thread, parseMailQuery("before:2026-11-11"))).toBe(true);
    const offset = summary("t2", { lastMessageAt: "2026-11-10T23:30:00-05:00" });
    expect(matchesQuery(offset, parseMailQuery("after:2026-11-11"))).toBe(true);
  });

  it("requires every term (AND)", () => {
    expect(matchesQuery(thread, parseMailQuery("from:alice nothing-here"))).toBe(false);
  });
});

describe("toProviderQuery", () => {
  const query = parseMailQuery('from:alice subject:"q3 report" has:attachment is:unread after:2026-11-01 before:2026-11-20 plan');

  it("builds Gmail search syntax", () => {
    expect(toProviderQuery(query, "gmail")).toBe(
      'from:alice subject:"q3 report" has:attachment is:unread after:2026/11/01 before:2026/11/20 plan',
    );
  });

  it("builds Outlook search syntax", () => {
    expect(toProviderQuery(query, "outlook")).toBe(
      'from:alice subject:"q3 report" hasattachments:true isread:false received>=2026-11-01 received<2026-11-20 plan',
    );
  });

  it("strips quotes and control characters from values", () => {
    const hostile = parseMailQuery('subject:"a\\" OR b"');
    expect(toProviderQuery(hostile, "gmail")).not.toContain('\\"');
    expect(toProviderQuery(parseMailQuery("hi\u0000there"), "gmail")).toBe("hi there");
  });
});
