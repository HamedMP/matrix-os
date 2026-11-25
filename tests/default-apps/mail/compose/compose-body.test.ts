import { describe, expect, it } from "vitest";
import { ComposeBody } from "../../../../home/apps/mail/src/compose/compose-body";
import { hasTrackedMarkup } from "../../../../home/apps/mail/src/compose/redline-body";

const ME = { author: "Me", date: "2026-11-20T10:00:00.000Z" };
const AI = { author: "Assistant", date: "2026-11-20T10:01:00.000Z" };
const LATER = "2026-11-21T09:00:00.000Z";

describe("ComposeBody without tracked changes", () => {
  it("keeps the owner's sanitised HTML and writes a plain draft body", () => {
    const body = ComposeBody.fromDraftHtml("", LATER);
    expect(body.userEdit('<div style="color:red" onclick="x">Hi <b>there</b></div>', ME)).toBe(true);
    expect(body.pendingCount()).toBe(0);
    expect(body.draftBody()).toEqual({ bodyHtml: "<div>Hi <b>there</b></div>", bodyText: "Hi there" });
    expect(body.userEdit("<div>Hi <b>there</b></div>", ME)).toBe(false);
  });

  it("treats a body with only blank markup as empty", () => {
    const body = ComposeBody.fromDraftHtml("", LATER);
    body.userEdit("<div><br></div>", ME);
    expect(body.draftBody()).toEqual({ bodyHtml: "", bodyText: "" });
  });
});

describe("assistant rewrites", () => {
  it("open as a redline that can be stepped, accepted and rejected one by one", () => {
    const body = ComposeBody.fromDraftHtml("<div>Thanks for the note. I can meet Monday.</div>", LATER);
    body.proposeRewrite("<div>Thanks for the note. I can meet on Tuesday instead.</div>", AI);
    const changes = body.changes();
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => c.author === "Assistant")).toBe(true);
    expect(body.markupHtml()).toMatch(/<ins class="redline-ins"/);
    const stored = body.draftBody();
    expect(hasTrackedMarkup(stored.bodyHtml)).toBe(true);
    expect(stored.bodyText).toContain("{+");

    body.reject([changes[0].id]);
    expect(body.pendingCount()).toBeLessThan(changes.length);
    body.accept("all");
    expect(body.pendingCount()).toBe(0);
    expect(hasTrackedMarkup(body.draftBody().bodyHtml)).toBe(false);
  });

  it("lets the owner keep typing while changes are pending, without tracking the owner's typing", () => {
    const body = ComposeBody.fromDraftHtml("<div>Hello Sam.</div>", LATER);
    body.proposeRewrite("<div>Hello Sam, thanks a lot.</div>", AI);
    const pending = body.pendingCount();
    body.userEdit("<div>Hello Sam, thanks a lot. Talk soon.</div>", ME);
    expect(body.pendingCount()).toBe(pending);
    expect(body.changes().every((c) => c.author === "Assistant")).toBe(true);
    expect(body.finalText()).toBe("Hello Sam, thanks a lot. Talk soon.");
    body.reject("all");
    expect(body.finalText()).toBe("Hello Sam. Talk soon.");
  });

  it("removing the text of a pending insertion simply shrinks it", () => {
    const body = ComposeBody.fromDraftHtml("<div>Hi.</div>", LATER);
    body.proposeRewrite("<div>Hi. Great news today.</div>", AI);
    body.userEdit("<div>Hi. Great news.</div>", ME);
    expect(body.finalText()).toBe("Hi. Great news.");
    body.accept("all");
    expect(body.finalText()).toBe("Hi. Great news.");
  });
});

describe("Suggest edits mode", () => {
  it("turns the owner's own typing into tracked changes", () => {
    const body = ComposeBody.fromDraftHtml("<div>We will ship on Friday.</div>", LATER);
    body.setSuggesting(true);
    body.userEdit("<div>We will ship on Monday.</div>", ME);
    const changes = body.changes();
    expect(changes.map((c) => [c.kind, c.text, c.author])).toEqual([["delete", "Friday", "Me"], ["insert", "Monday", "Me"]]);
    expect(body.draftBody().bodyText).toBe("We will ship on [-Friday-]{+Monday+}.");
  });

  it("is restored when the draft is reopened from its stored body", () => {
    const body = ComposeBody.fromDraftHtml("<div>We will ship on Friday.</div>", LATER);
    body.setSuggesting(true);
    body.userEdit("<div>We will ship on Monday.</div>", ME);
    const reopened = ComposeBody.fromDraftHtml(body.draftBody().bodyHtml, LATER);
    expect(reopened.pendingCount()).toBe(2);
    expect(reopened.finalText()).toBe("We will ship on Monday.");
    reopened.reject("all");
    expect(reopened.finalText()).toBe("We will ship on Friday.");
  });

  it("drops the redline once every change is resolved and suggesting is off", () => {
    const body = ComposeBody.fromDraftHtml("<div>a b</div>", LATER);
    body.setSuggesting(true);
    body.userEdit("<div>a c</div>", ME);
    body.setSuggesting(false);
    body.accept("all");
    expect(body.hasRedline()).toBe(false);
    expect(body.markupHtml()).toBe("<div>a c</div>");
  });
});

describe("listing", () => {
  it("returns the index of a change for the review bar and survives unknown ids", () => {
    const body = ComposeBody.fromDraftHtml("<div>one two three</div>", LATER);
    body.proposeRewrite("<div>one 2 three 4</div>", AI);
    const ids = body.changes().map((c) => c.id);
    expect(body.indexOf(ids[1])).toBe(1);
    expect(body.indexOf("missing")).toBe(-1);
    expect(() => body.accept(["missing"])).not.toThrow();
  });
});
