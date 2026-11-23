// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { MAX_PASTE_CHARS, pastedTextToHtml, sanitizePastedHtml } from "../../../../home/apps/mail/src/compose/paste";
import {
  MAX_SIGNATURE_CHARS,
  SIGNATURE_KEY,
  appendSignature,
  createSignatureStore,
  signatureHtml,
} from "../../../../home/apps/mail/src/compose/signature";

describe("sanitizePastedHtml", () => {
  it("keeps simple structure and drops scripts, handlers, styles, images and forms", () => {
    const html = sanitizePastedHtml(
      '<meta charset="utf-8"><div style="position:fixed" onclick="steal()"><b>Bold</b> <i>it</i> <u>u</u> <a href="https://example.com/x" onmouseover="x">link</a>'
      + '<img src="https://tracker.example/p.gif"><script>alert(1)</script><form><input value="x"></form></div><ul><li>one</li></ul><blockquote>q</blockquote>',
    );
    expect(html).toContain("<b>Bold</b>");
    expect(html).toContain("<i>it</i>");
    expect(html).toContain("<u>u</u>");
    expect(html).toContain('<a href="https://example.com/x">link</a>');
    expect(html).toContain("<ul><li>one</li></ul>");
    expect(html).toContain("<blockquote>");
    expect(html).not.toMatch(/script|onclick|onmouseover|style=|<img|<form|<input|<meta/i);
  });

  it("drops javascript links and pasted tracked-change markup", () => {
    const html = sanitizePastedHtml('<a href="javascript:alert(1)">x</a><ins class="redline-ins">new</ins><del>old</del>');
    expect(html).not.toMatch(/javascript|<ins|<del/i);
    expect(html).toContain("new");
  });

  it("caps very large pastes", () => {
    const html = sanitizePastedHtml(`<div>${"a".repeat(MAX_PASTE_CHARS * 2)}</div>`);
    expect(html.length).toBeLessThanOrEqual(MAX_PASTE_CHARS + 32);
  });

  it("escapes plain text and keeps its line breaks", () => {
    expect(pastedTextToHtml("a < b & c\nnext")).toBe("a &lt; b &amp; c<br>next");
  });
});

describe("signatures", () => {
  it("renders an escaped signature block below a separator", () => {
    expect(signatureHtml("Sam <CEO>\nMatrix")).toBe("<div><br></div><div>-- </div><div>Sam &lt;CEO&gt;</div><div>Matrix</div>");
    expect(signatureHtml("   ")).toBe("");
  });

  it("appends the signature once", () => {
    const once = appendSignature("<div>Hi</div>", "Sam");
    expect(once).toBe(`<div>Hi</div>${signatureHtml("Sam")}`);
    expect(appendSignature(once, "Sam")).toBe(once);
    expect(appendSignature("<div>Hi</div>", "")).toBe("<div>Hi</div>");
  });

  it("loads and saves a signature per account through the app's key-value store", async () => {
    const data: Record<string, unknown> = { [SIGNATURE_KEY]: { "gmail:me@example.com": "Me", bad: 5 } };
    const bridge = {
      readData: vi.fn(async (key: string) => data[key] ?? null),
      writeData: vi.fn(async (key: string, value: unknown) => {
        data[key] = value;
      }),
    };
    const store = createSignatureStore(bridge);
    await store.load();
    expect(store.get("gmail:me@example.com")).toBe("Me");
    expect(store.get("bad")).toBe("");
    await store.save("outlook:me@work.example", `Work\n${"x".repeat(MAX_SIGNATURE_CHARS)}`);
    const saved = data[SIGNATURE_KEY] as Record<string, string>;
    expect(saved["outlook:me@work.example"].length).toBe(MAX_SIGNATURE_CHARS);
    expect(saved["gmail:me@example.com"]).toBe("Me");
    expect(saved.bad).toBeUndefined();
  });

  it("works without a key-value store and survives a failing one", async () => {
    const none = createSignatureStore(undefined);
    await none.load();
    await none.save("a", "Sig");
    expect(none.get("a")).toBe("Sig");
    const failing = createSignatureStore({ readData: async () => { throw new Error("down"); }, writeData: async () => { throw new Error("down"); } });
    await expect(failing.load()).resolves.toBeUndefined();
    await expect(failing.save("a", "Sig")).rejects.toThrow();
  });
});
