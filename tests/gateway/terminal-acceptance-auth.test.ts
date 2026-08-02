import { createHash, createHmac, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createTerminalAcceptanceRoutes } from "../../packages/gateway/src/shell/terminal-acceptance-routes.js";

const SECRET = "acceptance-secret-that-is-never-sent";

function sign(body: string, timestamp: string, nonce: string): string {
  const digest = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", SECRET)
    .update(`v1\n${timestamp}\n${nonce}\n${digest}`)
    .digest("hex");
}

function request(body: string, timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("hex")) {
  return new Request("http://localhost/run", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-matrix-acceptance-timestamp": timestamp,
      "x-matrix-acceptance-nonce": nonce,
      "x-matrix-acceptance-signature": sign(body, timestamp, nonce),
    },
    body,
  });
}

describe("terminal production acceptance request authentication", () => {
  it("authenticates a bounded command without transmitting the reusable secret and signs the response", async () => {
    const run = vi.fn(async () => ({ stdout: "ok\n", stderr: "", exitCode: 0, signal: null, timedOut: false, truncated: false }));
    const app = new Hono().route("/", createTerminalAcceptanceRoutes({ secret: SECRET, run }));
    const body = JSON.stringify({ command: ["/usr/bin/true"], timeoutMs: 1_000 });
    const requestTimestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString("hex");
    const response = await app.request(request(body, requestTimestamp, nonce));

    expect(response.status).toBe(200);
    const responseBody = await response.text();
    const expectedResponseSignature = createHmac("sha256", SECRET)
      .update(`v1-response\n${requestTimestamp}\n${nonce}\n${createHash("sha256").update(responseBody).digest("hex")}`)
      .digest("hex");
    expect(response.headers.get("x-matrix-acceptance-response-signature")).toBe(expectedResponseSignature);
    expect(run).toHaveBeenCalledWith({ command: ["/usr/bin/true"], timeoutMs: 1_000 });
  });

  it("rejects stale, forged, and replayed requests before command execution", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, truncated: false }));
    const app = new Hono().route("/", createTerminalAcceptanceRoutes({ secret: SECRET, run }));
    const body = JSON.stringify({ command: ["/usr/bin/true"] });
    const valid = request(body);
    expect((await app.request(valid.clone())).status).toBe(200);
    expect((await app.request(valid.clone())).status).toBe(401);
    expect((await app.request(request(body, String(Math.floor(Date.now() / 1000) - 600)))).status).toBe(401);
    const forged = request(body);
    forged.headers.set("x-matrix-acceptance-signature", "0".repeat(64));
    expect((await app.request(forged)).status).toBe(401);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
