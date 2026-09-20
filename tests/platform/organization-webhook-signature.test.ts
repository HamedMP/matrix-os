import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyClerkWebhookSignature } from "../../packages/platform/src/organizations/webhook-signature.js";

const secretBytes = Buffer.from("0123456789abcdef0123456789abcdef");
const signingSecret = `whsec_${secretBytes.toString("base64")}`;
const body = '{"type":"organization.updated","data":{"id":"org_1"}}';

function sign(id: string, timestamp: number, payload: string, secret = secretBytes): string {
  return `v1,${createHmac("sha256", secret).update(`${id}.${timestamp}.${payload}`).digest("base64")}`;
}

describe("Clerk webhook signature verification", () => {
  const now = () => new Date(1_700_000_000_000);

  it("accepts a valid Standard Webhooks signature inside the timestamp tolerance", () => {
    const timestamp = 1_700_000_000 - 30;
    expect(verifyClerkWebhookSignature({
      signingSecret,
      body,
      headers: { "svix-id": "msg_1", "svix-timestamp": String(timestamp), "svix-signature": sign("msg_1", timestamp, body) },
      now,
    })).toEqual({ ok: true, eventId: "msg_1" });
  });

  it("accepts when any one of several space-separated signatures matches", () => {
    const timestamp = 1_700_000_000;
    const header = `${sign("msg_2", timestamp, body, Buffer.from("x".repeat(32)))} ${sign("msg_2", timestamp, body)}`;
    expect(verifyClerkWebhookSignature({ signingSecret, body, headers: { "svix-id": "msg_2", "svix-timestamp": String(timestamp), "svix-signature": header }, now }).ok).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, an old timestamp and missing headers", () => {
    const timestamp = 1_700_000_000;
    const valid = sign("msg_3", timestamp, body);
    expect(verifyClerkWebhookSignature({ signingSecret, body: body + " ", headers: { "svix-id": "msg_3", "svix-timestamp": String(timestamp), "svix-signature": valid }, now })).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(verifyClerkWebhookSignature({ signingSecret: "whsec_" + Buffer.from("y".repeat(32)).toString("base64"), body, headers: { "svix-id": "msg_3", "svix-timestamp": String(timestamp), "svix-signature": valid }, now })).toEqual({ ok: false, reason: "signature_mismatch" });
    const old = 1_700_000_000 - 600;
    expect(verifyClerkWebhookSignature({ signingSecret, body, headers: { "svix-id": "msg_3", "svix-timestamp": String(old), "svix-signature": sign("msg_3", old, body) }, now })).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
    expect(verifyClerkWebhookSignature({ signingSecret, body, headers: { "svix-timestamp": String(timestamp), "svix-signature": valid }, now })).toEqual({ ok: false, reason: "missing_headers" });
    expect(verifyClerkWebhookSignature({ signingSecret: "not-a-secret", body, headers: { "svix-id": "msg_3", "svix-timestamp": String(timestamp), "svix-signature": valid }, now })).toEqual({ ok: false, reason: "invalid_secret" });
  });
});
