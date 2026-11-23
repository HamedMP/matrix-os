// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeEmailHtml, textToHtml } from "../../../../home/apps/mail/src/html";
import { isAttributionLine } from "../../../../home/apps/mail/src/html/quotes";
import { expectInert } from "./helpers";

function collapsed(html: string) {
  const result = sanitizeEmailHtml(html);
  return { result, body: expectInert(result.html) };
}

describe("quoted replies in HTML mail", () => {
  it("collapses a gmail quote and trims the blank lines it leaves", () => {
    const html = '<div dir="ltr">Sounds good, see you then.</div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Mon, 2 Nov 2026 at 10:00, Ada &lt;ada@example.com&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex"><div>Shall we meet at noon?</div></blockquote></div>';
    const { result, body } = collapsed(html);
    expect(result.hasQuote).toBe(true);
    expect(result.quoteCollapsed).toBe(true);
    expect(body.textContent).toBe("Sounds good, see you then.");
    expect(body.querySelector("br")).toBeNull();

    const shown = sanitizeEmailHtml(html, { quotes: "show" });
    expect(shown.hasQuote).toBe(true);
    expect(shown.quoteCollapsed).toBe(false);
    expect(expectInert(shown.html).textContent).toContain("Shall we meet at noon?");
  });

  it("collapses a cite blockquote", () => {
    const { result, body } = collapsed('<div>Yes please.</div><div><br><blockquote type="cite"><div>On 2 Nov 2026, at 10:00, Ada wrote:</div><br><div>Coffee?</div></blockquote></div>');
    expect(result.quoteCollapsed).toBe(true);
    expect(body.textContent).toBe("Yes please.");
  });

  it("collapses an attribution line together with the blockquote after it", () => {
    const { result, body } = collapsed('<p>Agreed.</p><div class="moz-cite-prefix">On 02/11/2026 10:00, Ada wrote:<br></div><blockquote type="cite" cite="mid:abc@example.com"><p>Proposal attached.</p></blockquote>');
    expect(result.quoteCollapsed).toBe(true);
    expect(body.textContent).toBe("Agreed.");

    const plain = collapsed("<div>Fine by me.</div><div>On Monday, November 2, 2026, Ada Lovelace &lt;ada@example.com&gt; wrote:</div><blockquote>The earlier message.</blockquote>");
    expect(plain.result.quoteCollapsed).toBe(true);
    expect(plain.body.textContent).toBe("Fine by me.");
  });

  it("collapses an Outlook reply header and everything after it", () => {
    const { result, body } = collapsed('<div>Thanks, approved.</div><div id="appendonsend"></div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg" dir="ltr"><font face="Calibri, sans-serif"><b>From:</b> Ada<br><b>Sent:</b> Monday<br><b>To:</b> Grace<br><b>Subject:</b> Budget</font></div><div>Please approve the budget.</div>');
    expect(result.quoteCollapsed).toBe(true);
    expect(body.textContent).toBe("Thanks, approved.");
    expect(body.querySelector("hr")).toBeNull();
  });

  it("collapses other clients' quote containers", () => {
    expect(collapsed('<div>Ok.</div><div class="yahoo_quoted"><div>On Monday, Ada wrote:</div><div>Earlier</div></div>').body.textContent).toBe("Ok.");
    expect(collapsed('<div>Ok.</div><div class="protonmail_quote">Earlier</div>').body.textContent).toBe("Ok.");
  });

  it("leaves a forwarded message open", () => {
    const { result, body } = collapsed('<div dir="ltr">FYI<br><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: Ada<br></div><div>The original announcement.</div></div></div>');
    expect(result.quoteCollapsed).toBe(false);
    expect(body.textContent).toContain("The original announcement.");
  });

  it("leaves a message open when nothing would remain", () => {
    const { result, body } = collapsed('<div class="gmail_quote">On Mon, Ada wrote:<blockquote>Only a quote.</blockquote></div>');
    expect(result.hasQuote).toBe(false);
    expect(result.quoteCollapsed).toBe(false);
    expect(body.textContent).toContain("Only a quote.");
  });

  it("leaves interleaved and bottom-posted replies open", () => {
    const { result, body } = collapsed('<blockquote type="cite">First point</blockquote><div>Agreed.</div><blockquote type="cite">Second point</blockquote><div>Not sure.</div>');
    expect(result.quoteCollapsed).toBe(false);
    expect(body.textContent).toBe("First pointAgreed.Second pointNot sure.");
    expect(collapsed('<div>Hi</div><div class="gmail_quote">Earlier</div><div>My answer below the quote.</div>').result.quoteCollapsed).toBe(false);
  });

  it("does not treat an ordinary blockquote or sentence as a reply", () => {
    expect(collapsed("<p>As the saying goes:</p><blockquote>Measure twice.</blockquote>").result.hasQuote).toBe(false);
    expect(collapsed("<p>Hello</p><p>On Friday she wrote: come by.</p><p>Bye</p>").result.hasQuote).toBe(false);
  });

  it("keeps an image-only reply visible above the quote", () => {
    const { result } = collapsed('<div><img src="cid:photo"></div><div class="gmail_quote">On Mon, Ada wrote:<blockquote>Send the photo.</blockquote></div>');
    expect(result.quoteCollapsed).toBe(true);
  });
});

describe("isAttributionLine", () => {
  it("recognises reply attributions in several languages", () => {
    for (const line of [
      "On Mon, 2 Nov 2026 at 10:00, Ada <ada@example.com> wrote:",
      "On 02/11/2026 10:00, Ada wrote:",
      "> On 2 Nov 2026, at 10:00, Ada Lovelace <ada@example.com> wrote:",
      "Am 02.11.2026 um 10:00 schrieb Ada:",
      "Le lun. 2 nov. 2026 à 10:00, Ada <ada@example.com> a écrit :",
      "El lun, 2 nov 2026 a las 10:00, Ada escribió:",
      "Il giorno lun 2 nov 2026 alle ore 10:00 Ada ha scritto:",
      "Den mån 2 nov. 2026 kl 10:00 skrev Ada:",
      "-----Original Message-----",
      "________________________________",
    ]) expect(isAttributionLine(line), line).toBe(true);
  });

  it("rejects ordinary sentences", () => {
    for (const line of ["On Friday she wrote: come by.", "I wrote:", "wrote:", "Only once.", "On and on", `On ${"x".repeat(400)} wrote:`, ""]) {
      expect(isAttributionLine(line), line).toBe(false);
    }
  });
});

describe("quoted replies in plain-text mail", () => {
  const reply = "Sounds good.\n\nOn Mon, 2 Nov 2026 at 10:00, Ada <ada@example.com> wrote:\n> Shall we meet at noon?\n>\n> > Even earlier text\n> Ada";

  it("collapses the trailing quote", () => {
    const result = textToHtml(reply);
    expect(result.hasQuote).toBe(true);
    expect(result.quoteCollapsed).toBe(true);
    expect(expectInert(result.html).textContent).toBe("Sounds good.");
  });

  it("shows the quote as nested blockquotes on request", () => {
    const result = textToHtml(reply, { quotes: "show" });
    const body = expectInert(result.html);
    expect(result.quoteCollapsed).toBe(false);
    expect(body.querySelectorAll("blockquote").length).toBe(2);
    expect(body.querySelector("blockquote blockquote")?.textContent).toBe("Even earlier text");
    expect(body.querySelector("blockquote")?.textContent).toContain("Shall we meet at noon?");
    expect(body.querySelector("blockquote")?.textContent).not.toContain(">");
    expect(body.textContent).toContain("Ada <ada@example.com> wrote:");
  });

  it("collapses an original-message block", () => {
    const result = textToHtml("Approved.\n\n-----Original Message-----\nFrom: Ada\nSent: Monday\nSubject: Budget\n\nPlease approve.");
    expect(result.quoteCollapsed).toBe(true);
    expect(expectInert(result.html).textContent).toBe("Approved.");
  });

  it("leaves interleaved replies, forwards and quote-only text open", () => {
    expect(textToHtml("> First point\nAgreed.\n> Second point\nNot sure.").quoteCollapsed).toBe(false);
    expect(textToHtml("FYI\n\n---------- Forwarded message ---------\nFrom: Ada\n\nThe announcement.").quoteCollapsed).toBe(false);
    expect(textToHtml("On Mon, Ada wrote:\n> Only a quote").hasQuote).toBe(false);
    expect(textToHtml("Hello\nOn Friday she wrote: come by.\nBye").hasQuote).toBe(false);
  });
});
