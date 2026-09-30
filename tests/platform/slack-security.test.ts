import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackSignature, encryptSlackToken, decryptSlackToken, escapeSlackText } from "../../packages/platform/src/slack/security.js";

const now = new Date("2026-09-30T10:00:00Z");
const secret = "s".repeat(32);
const timestamp = String(now.getTime() / 1000);
const body = '{"text":"hi"}';
const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;

describe("Slack security", () => {
  it("verifies exact raw bytes and rejects stale, future, malformed, or changed bodies", () => {
    expect(verifySlackSignature({ secret, timestamp, signature, body, now })).toBe(true);
    for (const changed of [body + " ", '{"text":"other"}']) expect(verifySlackSignature({ secret, timestamp, signature, body: changed, now })).toBe(false);
    expect(verifySlackSignature({ secret, timestamp, signature, body, now: new Date(now.getTime() + 301_000) })).toBe(false);
    expect(verifySlackSignature({ secret, timestamp, signature, body, now: new Date(now.getTime() - 301_000) })).toBe(false);
    expect(verifySlackSignature({ secret, timestamp: "NaN", signature, body, now })).toBe(false);
    expect(verifySlackSignature({ secret, timestamp, signature: "v0=aa", body, now })).toBe(false);
  });
  it("authenticates randomized token encryption to the exact app/workspace", () => {
    const key = Buffer.alloc(32, 42).toString("base64");
    const context = "A123:T123";
    const ciphertext = encryptSlackToken("xoxb-secret", key, context);
    expect(ciphertext).not.toContain("xoxb-secret");
    expect(encryptSlackToken("xoxb-secret", key, context)).not.toBe(ciphertext);
    expect(decryptSlackToken(ciphertext, key, context)).toBe("xoxb-secret");
    expect(() => decryptSlackToken(ciphertext, key, "A123:T999")).toThrow();
    expect(() => decryptSlackToken(ciphertext.slice(0, -2) + "xx", key, context)).toThrow();
  });
  it("neutralizes mention/broadcast syntax and encodes ampersands", () => {
    expect(escapeSlackText("Hi <@U123> <!channel> & <https://example.com>")).toBe("Hi &lt;@U123&gt; &lt;!channel&gt; &amp; &lt;https://example.com&gt;");
  });
});
