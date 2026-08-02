import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import type { ShellCommandRunInput, ShellCommandRunResult } from "./command-runner.js";

const ACCEPTANCE_BODY_LIMIT = 16_384;
const ACCEPTANCE_CLOCK_SKEW_SECONDS = 120;
const ACCEPTANCE_NONCE_TTL_MS = 5 * 60 * 1_000;
const MAX_ACCEPTANCE_NONCES = 512;
const HEX_256 = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32}$/;

const AcceptanceCommandSchema = z.object({
  command: z.array(z.string().min(1).max(4096)).min(1).max(64),
  cwd: z.string().min(1).max(1024).optional(),
  timeoutMs: z.number().int().positive().max(30 * 60 * 1_000).optional(),
}).strict();

function digestBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function requestSignature(secret: string, timestamp: string, nonce: string, body: string): string {
  return createHmac("sha256", secret)
    .update(`v1\n${timestamp}\n${nonce}\n${digestBody(body)}`)
    .digest("hex");
}

function responseSignature(secret: string, timestamp: string, nonce: string, body: string): string {
  return createHmac("sha256", secret)
    .update(`v1-response\n${timestamp}\n${nonce}\n${digestBody(body)}`)
    .digest("hex");
}

function signatureMatches(actual: string | undefined, expected: string): boolean {
  if (!actual || !HEX_256.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function createTerminalAcceptanceRoutes(options: {
  secret: string;
  run: (input: ShellCommandRunInput) => Promise<ShellCommandRunResult | Record<string, unknown>>;
  now?: () => number;
}): Hono {
  const app = new Hono();
  const seenNonces = new Map<string, number>();
  const now = options.now ?? Date.now;

  app.post("/run", bodyLimit({ maxSize: ACCEPTANCE_BODY_LIMIT }), async (c) => {
    if (!options.secret) return c.json({ error: "Acceptance authentication unavailable" }, 503);
    const timestamp = c.req.header("x-matrix-acceptance-timestamp") ?? "";
    const nonce = c.req.header("x-matrix-acceptance-nonce") ?? "";
    const signature = c.req.header("x-matrix-acceptance-signature");
    const timestampSeconds = Number(timestamp);
    const nowMs = now();
    const nowSeconds = Math.floor(nowMs / 1_000);
    if (
      !/^\d{10}$/.test(timestamp)
      || !Number.isSafeInteger(timestampSeconds)
      || Math.abs(nowSeconds - timestampSeconds) > ACCEPTANCE_CLOCK_SKEW_SECONDS
      || !NONCE.test(nonce)
    ) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    for (const [candidate, expiresAt] of seenNonces) {
      if (expiresAt <= nowMs) seenNonces.delete(candidate);
    }
    if (seenNonces.has(nonce)) return c.json({ error: "Unauthorized" }, 401);
    if (seenNonces.size >= MAX_ACCEPTANCE_NONCES) {
      return c.json({ error: "Too many requests" }, 429);
    }

    const rawBody = await c.req.text();
    if (!signatureMatches(signature, requestSignature(options.secret, timestamp, nonce, rawBody))) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) {
        console.warn("[terminal-acceptance] request parsing failed", err instanceof Error ? err.name : typeof err);
      }
      return c.json({ error: "Invalid request" }, 400);
    }
    const parsed = AcceptanceCommandSchema.safeParse(parsedBody);
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    seenNonces.set(nonce, nowMs + ACCEPTANCE_NONCE_TTL_MS);

    try {
      const responseBody = JSON.stringify(await options.run(parsed.data));
      return new Response(responseBody, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "cache-control": "no-store",
          "x-matrix-acceptance-response-signature": responseSignature(
            options.secret,
            timestamp,
            nonce,
            responseBody,
          ),
        },
      });
    } catch (err: unknown) {
      console.warn("[terminal-acceptance] command execution failed", err instanceof Error ? err.name : typeof err);
      return c.json({ error: "Command execution failed" }, 500);
    }
  });

  return app;
}
