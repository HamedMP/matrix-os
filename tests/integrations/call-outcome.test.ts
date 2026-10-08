import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { integrationActionFailure } from "../../packages/gateway/src/integrations/call-outcome.js";

type ProviderError = Error & Record<string, unknown>;

function providerError(status: number, extra: Record<string, unknown> = {}, message = "provider said no"): ProviderError {
  return Object.assign(new Error(message), { statusCode: status }, extra);
}

async function answer(err: unknown): Promise<{ status: number; retryAfter: string | null; body: Record<string, unknown> }> {
  const app = new Hono();
  app.get("/", (c) => integrationActionFailure(c, err, "github", "get_pr"));
  const response = await app.request("/");
  return { status: response.status, retryAfter: response.headers.get("retry-after"), body: await response.json() };
}

describe("integration call failure mapping", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [401, "unauthorized"], [403, "unauthorized"], [404, "not_found"], [410, "not_found"],
  ])("names the provider's %i answer in the 502 without its text", async (status, upstream) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await answer(providerError(status, { body: { message: "Bad credentials for secret-repo" } }));
    expect(result.status).toBe(502);
    expect(result.body).toEqual({ error: "Integration call failed", upstream });
    expect(JSON.stringify(result.body)).not.toContain("secret-repo");
  });

  it.each([400, 422, 500, 503])("keeps the bare 502 for a provider %i", async (status) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await answer(providerError(status));
    expect(result.status).toBe(502);
    expect(result.body).toEqual({ error: "Integration call failed" });
  });

  it("keeps the bare 502 for an error with no status", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await answer(new Error("boom"))).body).toEqual({ error: "Integration call failed" });
  });

  it.each([
    ["a retry-after header", providerError(403, { headers: { "retry-after": "17" } }), "17"],
    ["Pipedream raw response headers", providerError(403, {
      rawResponse: { status: 403, headers: new Headers({ "retry-after": "9" }) },
    }), "9"],
    ["x-ratelimit-remaining 0", providerError(403, { headers: new Headers({ "x-ratelimit-remaining": "0" }) }), "60"],
    ["x-ratelimit-remaining 0 in raw headers", providerError(403, {
      rawResponse: { status: 403, headers: new Headers({ "x-ratelimit-remaining": "0" }) },
    }), "60"],
    ["a rate limit message", providerError(403, {}, "You have exceeded a secondary rate limit"), "60"],
    ["a rate limit message in the body", providerError(403, { body: { message: "API rate limit exceeded" } }), "60"],
    ["a rate limit body string", providerError(403, { body: "User Rate Limit Exceeded" }), "60"],
  ])("answers a 403 with %s as 429", async (_name, err, retryAfter) => {
    const result = await answer(err);
    expect(result.status).toBe(429);
    expect(result.retryAfter).toBe(retryAfter);
    expect(result.body).toEqual({
      error: "Rate limited by provider. Please try again later.", retry_after: Number(retryAfter),
    });
  });

  it("does not read a 403 as a rate limit from remaining requests or a message far into the text", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const remaining = await answer(providerError(403, { headers: { "x-ratelimit-remaining": "12" } }));
    expect(remaining).toMatchObject({ status: 502, body: { upstream: "unauthorized" } });
    const late = await answer(providerError(403, {}, `${"x".repeat(4_096)} rate limit`));
    expect(late).toMatchObject({ status: 502, body: { upstream: "unauthorized" } });
  });

  it("keeps a 429 as a rate limit", async () => {
    const result = await answer(providerError(429, { headers: { "retry-after": "30" } }));
    expect(result).toMatchObject({ status: 429, retryAfter: "30", body: { retry_after: 30 } });
  });
});
