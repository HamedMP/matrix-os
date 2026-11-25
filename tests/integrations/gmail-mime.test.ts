import { describe, expect, it } from "vitest";
import {
  MAX_RAW_MESSAGE_BYTES, MimeBuildError, buildGmailRaw, buildMimeMessage, encodeHeaderWords, toBase64Url, wrapBase64,
  type MimeMessageInput,
} from "../../packages/gateway/src/integrations/gmail-mime.js";

// Independent reader for the produced message: unfolds headers, splits
// multipart bodies and decodes RFC 2047 words without using the builder.
interface Entity { headers: [string, string][]; body: string }
function parseEntity(text: string): Entity {
  const split = text.indexOf("\r\n\r\n");
  const head = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? "" : text.slice(split + 4);
  const headers = head.replace(/\r\n(?=[ \t])/g, "").split("\r\n").filter(Boolean).map((line): [string, string] => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon), line.slice(colon + 1).trim()];
  });
  return { headers, body };
}
const header = (entity: Entity, name: string) => entity.headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
const boundaryOf = (entity: Entity) => /boundary="([^"]+)"/.exec(header(entity, "Content-Type") ?? "")?.[1];
function parts(entity: Entity): Entity[] {
  const boundary = boundaryOf(entity)!;
  const [, ...rest] = entity.body.split(`--${boundary}`);
  expect(rest.at(-1)!.startsWith("--")).toBe(true);
  return rest.slice(0, -1).map((chunk) => parseEntity(chunk.replace(/^\r\n/, "").replace(/\r\n$/, "")));
}
const decodeBody = (entity: Entity) => Buffer.from(entity.body.replace(/\r\n/g, ""), "base64").toString("utf8");
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
function decodeWords(value: string): string {
  return value.replace(/\?=\s+=\?/g, "?==?").replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/g,
    (_, b64: string) => strictUtf8.decode(Buffer.from(b64, "base64")));
}

const fixed = () => { let n = 0; return () => `=_test_${++n}`; };
const base: MimeMessageInput = {
  to: [{ address: "ada@example.com", name: "Ada Lovelace" }],
  subject: "Quarterly review",
  bodyText: "Hello Ada,\nSee you.",
  bodyHtml: "<p>Hello Ada,</p><p>See you.</p>",
};

describe("gmail MIME builder", () => {
  it("builds a multipart/alternative message with text then HTML, base64 UTF-8, and no From or Date", () => {
    const message = buildMimeMessage(base, { boundary: fixed() });
    expect(message).not.toMatch(/(^|[^\r])\n/);
    const top = parseEntity(message);
    expect(top.headers.map(([name]) => name)).toEqual(["To", "Subject", "MIME-Version", "Content-Type"]);
    expect(header(top, "To")).toBe("\"Ada Lovelace\" <ada@example.com>");
    expect(header(top, "Subject")).toBe("Quarterly review");
    expect(header(top, "MIME-Version")).toBe("1.0");
    expect(header(top, "Content-Type")).toBe("multipart/alternative; boundary=\"=_test_1\"");
    const [text, html, ...extra] = parts(top);
    expect(extra).toEqual([]);
    expect(header(text!, "Content-Type")).toBe("text/plain; charset=UTF-8");
    expect(header(text!, "Content-Transfer-Encoding")).toBe("base64");
    expect(decodeBody(text!)).toBe("Hello Ada,\r\nSee you.");
    expect(header(html!, "Content-Type")).toBe("text/html; charset=UTF-8");
    expect(decodeBody(html!)).toBe(base.bodyHtml);
    expect(message.split("\r\n").every((line) => line.length <= 78)).toBe(true);
  });

  it("uses a fresh random boundary per message that cannot occur in base64 content", () => {
    const first = boundaryOf(parseEntity(buildMimeMessage(base)))!;
    const second = boundaryOf(parseEntity(buildMimeMessage(base)))!;
    expect(first).not.toBe(second);
    expect(first).toMatch(/^=_mx_[0-9a-f]{32}$/);
  });

  it("emits Cc, Bcc, In-Reply-To and space-separated References for threaded replies", () => {
    const message = buildMimeMessage({
      ...base, cc: [{ address: "bob@example.com" }], bcc: [{ address: "eve@example.com", name: "Eve" }],
      inReplyTo: "<b@mail.example.com>", references: ["<a@mail.example.com>", "<b@mail.example.com>"],
    }, { boundary: fixed() });
    const top = parseEntity(message);
    expect(top.headers.map(([name]) => name)).toEqual(["To", "Cc", "Bcc", "Subject", "In-Reply-To", "References", "MIME-Version", "Content-Type"]);
    expect(header(top, "Cc")).toBe("bob@example.com");
    expect(header(top, "Bcc")).toBe("\"Eve\" <eve@example.com>");
    expect(header(top, "In-Reply-To")).toBe("<b@mail.example.com>");
    expect(header(top, "References")).toBe("<a@mail.example.com> <b@mail.example.com>");
  });

  it("folds long recipient lists and long message-id chains without exceeding line limits", () => {
    const to = Array.from({ length: 40 }, (_, i) => ({ address: `person${i}@example.com`, name: `Person Number ${i}` }));
    const longId = `<${"x".repeat(990)}@e>`;
    const message = buildMimeMessage({ ...base, to, inReplyTo: longId, references: [longId, "<short@e>"] }, { boundary: fixed() });
    const lines = message.split("\r\n");
    expect(lines.every((line) => line.length <= 998)).toBe(true);
    expect(lines.filter((line) => line.length > 78).every((line) => line.includes(longId))).toBe(true);
    const top = parseEntity(message);
    expect(header(top, "To")).toBe(to.map((r) => `"${r.name}" <${r.address}>`).join(", "));
    expect(header(top, "In-Reply-To")).toBe(longId);
    expect(header(top, "References")).toBe(`${longId} <short@e>`);
  });

  it("encodes non-ASCII subjects and display names as RFC 2047 words split on character boundaries", () => {
    const subject = "Résumé für Zoë 🎉 ".repeat(14).trim();
    const message = buildMimeMessage({ ...base, subject, to: [{ address: "zoe@example.com", name: "Zoë Øster 名前" }] }, { boundary: fixed() });
    const top = parseEntity(message);
    expect(decodeWords(header(top, "Subject")!)).toBe(subject);
    expect(decodeWords(header(top, "To")!)).toBe("Zoë Øster 名前 <zoe@example.com>");
    const words = message.match(/=\?UTF-8\?B\?[^?]*\?=/g)!;
    expect(words.length).toBeGreaterThan(5);
    for (const word of words) expect(word.length).toBeLessThanOrEqual(75);
    expect(message.split("\r\n").every((line) => line.length <= 78)).toBe(true);
  });

  it("encodes ASCII text that would otherwise look like an encoded word and preserves exact spacing", () => {
    expect(encodeHeaderWords("=?UTF-8?B?x?=")[0]).toMatch(/^=\?UTF-8\?B\?/);
    const top = parseEntity(buildMimeMessage({ ...base, subject: "  two  spaces ", to: [{ address: "a@example.com", name: "=?x?=" }] }, { boundary: fixed() }));
    expect(decodeWords(header(top, "Subject")!)).toBe("  two  spaces ");
    expect(header(top, "To")).toMatch(/^=\?UTF-8\?B\?/);
    expect(header(parseEntity(buildMimeMessage({ ...base, subject: "" }, { boundary: fixed() })), "Subject")).toBe("");
  });

  it("quotes ASCII display names with escaped quotes and backslashes", () => {
    const top = parseEntity(buildMimeMessage({ ...base, to: [{ address: "a@example.com", name: "Ada \"The\" \\ L" }] }, { boundary: fixed() }));
    expect(header(top, "To")).toBe("\"Ada \\\"The\\\" \\\\ L\" <a@example.com>");
  });

  it("makes header injection impossible through subjects and names", () => {
    const message = buildMimeMessage({
      ...base, subject: "Hi\r\nBcc: attacker@evil.example\r\n\r\nbody",
      to: [{ address: "a@example.com", name: "Ada\r\nBcc: attacker@evil.example" }],
      cc: [{ address: "b@example.com", name: "\u2028Bob\u0085" }],
    }, { boundary: fixed() });
    const top = parseEntity(message);
    expect(top.headers.map(([name]) => name)).toEqual(["To", "Cc", "Subject", "MIME-Version", "Content-Type"]);
    expect(message).not.toMatch(/\r\nBcc:/);
    expect(header(top, "Subject")).toBe("HiBcc: attacker@evil.examplebody");
    expect(header(top, "To")).toBe("\"AdaBcc: attacker@evil.example\" <a@example.com>");
    expect(header(top, "Cc")).toBe("\"Bob\" <b@example.com>");
  });

  it.each([
    ["address with CRLF", { to: [{ address: "a@example.com\r\nBcc: e@evil.example" }] }, "invalid_address"],
    ["address with angle bracket", { cc: [{ address: "a@example.com>, e@evil.example" }] }, "invalid_address"],
    ["address with comma", { bcc: [{ address: "a@example.com,e@evil.example" }] }, "invalid_address"],
    ["address without domain", { to: [{ address: "nobody" }] }, "invalid_address"],
    ["address too long", { to: [{ address: `${"a".repeat(250)}@e.co` }] }, "invalid_address"],
    ["message id with CRLF", { inReplyTo: "<a@b>\r\nBcc: e@evil.example" }, "invalid_message_id"],
    ["message id without brackets", { references: ["a@b"] }, "invalid_message_id"],
    ["message id with space", { inReplyTo: "<a b@c>" }, "invalid_message_id"],
    ["attachment filename with slash", { attachments: [{ filename: "../x", mimeType: "text/plain", contentBase64: "" }] }, "invalid_attachment"],
    ["attachment filename with quote", { attachments: [{ filename: "a\".txt", mimeType: "text/plain", contentBase64: "" }] }, "invalid_attachment"],
    ["attachment filename with CRLF", { attachments: [{ filename: "a\r\nX: y", mimeType: "text/plain", contentBase64: "" }] }, "invalid_attachment"],
    ["attachment mime type with parameters", { attachments: [{ filename: "a", mimeType: "text/plain; x=\"y\"", contentBase64: "" }] }, "invalid_attachment"],
    ["attachment invalid base64", { attachments: [{ filename: "a", mimeType: "text/plain", contentBase64: "abc" }] }, "invalid_attachment"],
    ["attachment base64 with newline", { attachments: [{ filename: "a", mimeType: "text/plain", contentBase64: "YWJj\nZA==" }] }, "invalid_attachment"],
  ] as [string, Partial<MimeMessageInput>, string][])("rejects %s", (_, patch, reason) => {
    expect(() => buildMimeMessage({ ...base, ...patch })).toThrow(MimeBuildError);
    try { buildMimeMessage({ ...base, ...patch }); } catch (error) { expect((error as MimeBuildError).reason).toBe(reason); }
  });

  it("wraps attachments in multipart/mixed after the alternative part with 76-column base64", () => {
    const pdf = Buffer.alloc(300, 7);
    const message = buildMimeMessage({
      ...base, attachments: [
        { filename: "report final.pdf", mimeType: "application/pdf", contentBase64: pdf.toString("base64") },
        { filename: "Ångström-Übersicht-mit-einem-sehr-langen-Namen-für-die-Kopfzeile.txt", mimeType: "text/plain", contentBase64: Buffer.from("hej").toString("base64") },
      ],
    }, { boundary: fixed() });
    const top = parseEntity(message);
    expect(header(top, "Content-Type")).toBe("multipart/mixed; boundary=\"=_test_1\"");
    const [alternative, first, second, ...extra] = parts(top);
    expect(extra).toEqual([]);
    expect(header(alternative!, "Content-Type")).toBe("multipart/alternative; boundary=\"=_test_2\"");
    expect(parts(alternative!).map((part) => header(part, "Content-Type"))).toEqual(["text/plain; charset=UTF-8", "text/html; charset=UTF-8"]);
    expect(header(first!, "Content-Type")).toBe("application/pdf; name=\"report final.pdf\"");
    expect(header(first!, "Content-Disposition")).toBe("attachment; filename=\"report final.pdf\"");
    expect(header(first!, "Content-Transfer-Encoding")).toBe("base64");
    const lines = first!.body.split("\r\n");
    expect(lines.slice(0, -1).every((line) => line.length === 76)).toBe(true);
    expect(Buffer.from(first!.body.replace(/\r\n/g, ""), "base64").equals(pdf)).toBe(true);
    const disposition = header(second!, "Content-Disposition")!;
    expect(disposition).toMatch(/^attachment; filename\*0\*=UTF-8''/);
    const encoded = [...disposition.matchAll(/filename\*\d+\*=(?:UTF-8'')?([^;]*)/g)].map((m) => m[1]).join("");
    expect(decodeURIComponent(encoded)).toBe("Ångström-Übersicht-mit-einem-sehr-langen-Namen-für-die-Kopfzeile.txt");
    expect(decodeBody(second!)).toBe("hej");
    expect(message.split("\r\n").every((line) => line.length <= 78)).toBe(true);
  });

  it("caps the total raw size", () => {
    expect(MAX_RAW_MESSAGE_BYTES).toBe(256 * 1024);
    const big = "x".repeat(200 * 1024);
    expect(() => buildMimeMessage({ ...base, bodyText: big, bodyHtml: big })).toThrow(MimeBuildError);
    const blob = Buffer.alloc(150 * 1024).toString("base64");
    expect(() => buildMimeMessage({ ...base, attachments: [{ filename: "a.bin", mimeType: "application/octet-stream", contentBase64: blob }, { filename: "b.bin", mimeType: "application/octet-stream", contentBase64: blob }] }))
      .toThrow(expect.objectContaining({ reason: "too_large" }));
  });

  it("wraps base64 at 76 columns and encodes the API form as unpadded base64url", () => {
    expect(wrapBase64("A".repeat(160))).toBe(`${"A".repeat(76)}\r\n${"A".repeat(76)}\r\n${"A".repeat(8)}`);
    expect(wrapBase64("")).toBe("");
    const message = "Subject: ??>>\r\n\r\nÿ";
    const raw = toBase64Url(message);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(raw, "base64url").toString("utf8")).toBe(message);
    const gmailRaw = buildGmailRaw(base, { boundary: fixed() });
    expect(Buffer.from(gmailRaw, "base64url").toString("utf8")).toBe(buildMimeMessage(base, { boundary: fixed() }));
  });
});
