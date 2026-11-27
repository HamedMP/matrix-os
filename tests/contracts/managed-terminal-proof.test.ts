import { describe, expect, it } from "vitest";
import {
  createManagedTerminalHeaders,
  createManagedTerminalVerifier,
  createManagedTerminalReplyHeaders,
  openManagedTerminalPayload,
  sealManagedTerminalPayload,
  verifyManagedTerminalReply,
  MANAGED_TERMINAL_NONCE_HEADER,
} from "@matrix-os/contracts/managed-terminal-proof";

const token = "48".repeat(32);
const now = 1_700_000_000_000;
function request(body: string, headers: HeadersInit) {
  return new Request("https://example.test/internal/terminal-control", { method: "POST", body, headers });
}

describe("managed terminal service proof", () => {
  it("authenticates exact bytes with one-time admission and rejects purpose or key substitution", () => {
    const body = '{"request":{"kind":"computers"}}';
    const headers = createManagedTerminalHeaders(token, "source", body, { issuedAt: now });
    const verifier = createManagedTerminalVerifier({ direction: "source", now: () => now });
    expect(createManagedTerminalVerifier({ direction: "target", now: () => now })(request(body, headers), token, body)).toBeNull();
    expect(verifier(request(body, headers), "59".repeat(32), body)).toBeNull();
    expect(verifier(request(body + " ", headers), token, body + " ")).toBeNull();
    expect(verifier(request(body, headers), token, body)?.aborted).toBe(false);
    expect(verifier(request(body, headers), token, body)).toBeNull();
  });

  it("preserves a nonce across broker attempts and rejects an expired or future proof", () => {
    const body = '{}';
    const nonce = crypto.randomUUID();
    const headers = createManagedTerminalHeaders(token, "target", body, { issuedAt: now, nonce });
    const verifier = createManagedTerminalVerifier({ direction: "target", now: () => now + 20_000 });
    expect(new Headers(headers).get(MANAGED_TERMINAL_NONCE_HEADER)).toBe(nonce);
    expect(verifier(request(body, headers), token, body)).toBeNull();
    const future = createManagedTerminalVerifier({ direction: "target", now: () => now - 5000 });
    expect(future(request(body, headers), token, body)).toBeNull();
  });

  it("keeps target content private and binds the reply to the expected request and status", () => {
    const nonce = crypto.randomUUID();
    const result = JSON.stringify({ result: { screen: "private terminal output" } });
    const sealed = sealManagedTerminalPayload(token, "target-response", result);
    expect(sealed).not.toContain("private terminal output");
    const headers = createManagedTerminalReplyHeaders(token, sealed, 200, now, nonce);
    const response = new Response(sealed, { status: 200, headers });
    expect(verifyManagedTerminalReply(token, response, sealed, now, nonce)).toBe(true);
    expect(verifyManagedTerminalReply(token, response, sealed, now, crypto.randomUUID())).toBe(false);
    expect(verifyManagedTerminalReply(token, new Response(sealed, { status: 409, headers }), sealed, now, nonce)).toBe(false);
    expect(openManagedTerminalPayload(token, "target-response", sealed)).toBe(result);
    expect(openManagedTerminalPayload(token, "target", sealed)).toBeNull();
    expect(openManagedTerminalPayload("59".repeat(32), "target-response", sealed)).toBeNull();
    expect(openManagedTerminalPayload(token, "target-response", result)).toBeNull();
  });
});
