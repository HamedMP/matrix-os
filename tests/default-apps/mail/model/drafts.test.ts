import { describe, expect, it } from "vitest";
import {
  MAX_QUOTED_CHARS,
  buildDraftFromThread,
  composeDraft,
  forwardSubject,
  replyMetaFromThread,
  replySubject,
} from "../../../../home/apps/mail/src/model/drafts";
import type { DraftState } from "../../../../home/apps/mail/src/model/types";
import { emptyDraft } from "../../../../home/apps/_shared/office-accounts/types/mail";
import { GMAIL, message, thread } from "./fixtures";

const OPTIONS = { owner: GMAIL, timeZone: "UTC" };

describe("subjects", () => {
  it("adds a reply prefix once", () => {
    expect(replySubject("Plans")).toBe("Re: Plans");
    expect(replySubject("RE: Plans")).toBe("RE: Plans");
    expect(replySubject("")).toBe("Re: ");
  });

  it("adds a forward prefix once", () => {
    expect(forwardSubject("Plans")).toBe("Fwd: Plans");
    expect(forwardSubject("Fw: Plans")).toBe("Fw: Plans");
    expect(forwardSubject("fwd: Plans")).toBe("fwd: Plans");
  });
});

describe("buildDraftFromThread", () => {
  const conversation = thread("t1", [
    message("m1", { from: { name: "Bob", address: "bob@example.com" }, to: [{ address: "me@example.com" }], sentAt: "2026-11-09T08:00:00Z" }),
    message("m2", {
      from: { name: "Alice", address: "Alice@Example.com" },
      to: [{ name: "Me", address: "me@example.com" }, { address: "carol@example.com" }],
      cc: [{ address: "bob@example.com" }, { address: "ME@example.com" }],
      sentAt: "2026-11-10T09:00:00Z",
    }),
    message("d1", { from: { address: "me@example.com" }, draftId: "draft-1", sentAt: "2026-11-11T09:00:00Z" }),
  ]);

  it("replies to the sender of the last sent message and threads the reply", () => {
    const built = buildDraftFromThread("reply", conversation, OPTIONS);
    expect(built.draft.to).toEqual([{ name: "Alice", address: "alice@example.com" }]);
    expect(built.draft.cc).toEqual([]);
    expect(built.draft.subject).toBe("Re: Plans");
    expect(built.draft.threadId).toBe("t1");
    expect(built.draft.inReplyToMessageId).toBe("m2");
  });

  it("reply all adds everyone except the owner without duplicates", () => {
    const built = buildDraftFromThread("replyAll", conversation, OPTIONS);
    expect(built.draft.to.map((a) => a.address)).toEqual(["alice@example.com", "carol@example.com"]);
    expect(built.draft.cc.map((a) => a.address)).toEqual(["bob@example.com"]);
  });

  it("replying to the owner's own message goes to its recipients", () => {
    const own = thread("t2", [message("m1", { from: { address: "me@example.com" }, to: [{ address: "dan@example.com" }] })]);
    expect(buildDraftFromThread("reply", own, OPTIONS).draft.to).toEqual([{ address: "dan@example.com" }]);
  });

  it("quotes the plain text escaped as HTML, never the provider HTML", () => {
    const built = buildDraftFromThread("reply", conversation, OPTIONS);
    expect(built.quote?.text).toContain("Alice <Alice@Example.com> wrote:");
    expect(built.quote?.text).toContain("> Hello\n> See you <soon> & bye");
    expect(built.quote?.html).toContain("See you &lt;soon&gt; &amp; bye");
    expect(built.quote?.html).toContain("<blockquote");
    expect(built.quote?.html).not.toContain("<script");
    expect(built.quote?.text).toMatch(/Nov 10, 2026/);
  });

  it("forwards with a header block, no recipients and no threading", () => {
    const built = buildDraftFromThread("forward", conversation, OPTIONS);
    expect(built.draft.to).toEqual([]);
    expect(built.draft.threadId).toBeUndefined();
    expect(built.draft.subject).toBe("Fwd: Plans");
    expect(built.quote?.text).toContain("---------- Forwarded message ----------");
    expect(built.quote?.text).toContain("From: Alice <Alice@Example.com>");
    expect(built.quote?.text).toContain("To: Me <me@example.com>, carol@example.com");
    expect(built.quote?.text).not.toContain("> Hello");
  });

  it("answers the chosen message when one is given", () => {
    expect(buildDraftFromThread("reply", conversation, { ...OPTIONS, messageId: "m1" }).draft.to[0].address).toBe("bob@example.com");
  });

  it("caps the quoted text", () => {
    const long = thread("t3", [message("m1", { bodyText: "x".repeat(MAX_QUOTED_CHARS * 2) })]);
    const built = buildDraftFromThread("reply", long, OPTIONS);
    expect(built.quote!.text.length).toBeLessThan(MAX_QUOTED_CHARS + 500);
  });

  it("strips line breaks from a hostile subject", () => {
    const hostile = thread("t4", [message("m1", { subject: "Hi\r\nBcc: x@evil.example" })]);
    expect(buildDraftFromThread("reply", hostile, OPTIONS).draft.subject).toBe("Re: Hi Bcc: x@evil.example");
  });

  it("throws for a thread with nothing to answer", () => {
    expect(() => buildDraftFromThread("reply", thread("t5", []), OPTIONS)).toThrow(RangeError);
  });
});

describe("composeDraft", () => {
  function state(overrides: Partial<DraftState>): DraftState {
    return {
      localId: "l", accountId: GMAIL.id, kind: "reply", sourceThreadKey: null,
      draft: { ...emptyDraft(), bodyText: "Sounds good", bodyHtml: "" }, quote: { text: "> q", html: "<blockquote>q</blockquote>" },
      revision: 1, savedRevision: 0, saving: false, sending: false, open: true, issues: [], error: null, savedAt: null,
      ...overrides,
    };
  }

  it("appends the quote to the owner's text and derives HTML when none was written", () => {
    const draft = composeDraft(state({}));
    expect(draft.bodyText).toBe("Sounds good\n\n> q");
    expect(draft.bodyHtml).toBe("<div>Sounds good</div><br><blockquote>q</blockquote>");
  });

  it("keeps owner HTML and leaves a draft without a quote unchanged", () => {
    const own = { ...emptyDraft(), bodyText: "a", bodyHtml: "<p>a</p>" };
    expect(composeDraft(state({ quote: null, draft: own }))).toEqual(own);
    expect(composeDraft(state({ draft: own })).bodyHtml).toBe("<p>a</p><br><blockquote>q</blockquote>");
  });
});

describe("replyMetaFromThread", () => {
  it("notes who sent the last non-draft message", () => {
    const conversation = thread("t1", [
      message("m1", { from: { address: "alice@example.com" }, sentAt: "2026-11-09T08:00:00Z" }),
      message("m2", { from: { address: "ME@example.com" }, sentAt: "2026-11-10T08:00:00Z" }),
      message("d", { from: { address: "me@example.com" }, draftId: "x", sentAt: "2026-11-11T08:00:00Z" }),
    ]);
    expect(replyMetaFromThread(conversation, GMAIL)).toEqual({ lastFrom: "me@example.com", lastAt: "2026-11-10T08:00:00Z", ownerSentLast: true });
    expect(replyMetaFromThread(thread("e", []), GMAIL)).toBeNull();
  });
});
