import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { inspectGatewayMetadata, runReadOnlyInspection } from "../../scripts/ops/cloudflare-gateway-readonly.mjs";

const account = "a".repeat(32);
const token = "private-operator-credential-".repeat(2);
const config = { accountId: account, token, gatewayId: "matrix-funded-production" };

describe("read-only Cloudflare Gateway credential inspection", () => {
  it("reads only the official gateway endpoint and suppresses all filter values", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ success: true, result: {
      id: config.gatewayId, authentication: true, collect_logs: false,
      spend_limits: { rules: [{ metadata: { runtime_ref: { mode: "filter", values: ["private-owner-reference"] } } }] },
      unrelated: "private-configuration",
    } }));
    const result = await inspectGatewayMetadata(config, fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      `https://api.cloudflare.com/client/v4/accounts/${account}/ai-gateway/gateways/${config.gatewayId}`,
      expect.objectContaining({ method: "GET", redirect: "error", signal: expect.any(AbortSignal),
        headers: { authorization: `Bearer ${token}` } }),
    );
    expect(result).toMatchObject({ gatewayId: config.gatewayId, httpStatus: 200, readable: true,
      authenticationRequired: true, spendRuleCount: 1 });
    expect(JSON.stringify(result)).not.toMatch(/private-|Bearer/);
  });

  it("records safe error codes without exposing the remote error body", async () => {
    const result = await inspectGatewayMetadata(config, vi.fn().mockResolvedValue(Response.json({
      success: false, errors: [{ code: 10000, message: token }], result: { credential: token },
    }, { status: 403 })));
    expect(result).toMatchObject({ httpStatus: 403, readable: false, errorCodes: [10000] });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it.each(["other-gateway", "../production", "matrix-funded-production?secret=x"])("rejects unreviewed gateway %s before using credentials", async gatewayId => {
    const fetcher = vi.fn();
    await expect(inspectGatewayMetadata({ ...config, gatewayId }, fetcher)).rejects.toThrow("Invalid inspection configuration");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not copy credentials or arbitrary fetch errors into the result", async () => {
    const result = await inspectGatewayMetadata(config, vi.fn().mockRejectedValue(new Error(`failed ${token}`)));
    expect(result).toMatchObject({ readable: false, transportFailed: true });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("rejects mismatching gateway identity and an oversized response", async () => {
    const wrong = await inspectGatewayMetadata(config, vi.fn().mockResolvedValue(Response.json({ success: true, result: { id: "matrix-funded-preview" } })));
    expect(wrong.readable).toBe(false);
    const oversized = await inspectGatewayMetadata(config, vi.fn().mockResolvedValue(new Response("x".repeat(65537))));
    expect(oversized.readable).toBe(false);
    expect(oversized.invalidResponse).toBe(true);
  });

  it("rejects non-main execution and an account mismatch before any request", async () => {
    const fetcher = vi.fn();
    const env = { GITHUB_REF: "refs/heads/test", CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: account,
      CLOUDFLARE_AI_GATEWAY_URL: `https://gateway.ai.cloudflare.com/v1/${account}/matrix-funded-production/anthropic` };
    await expect(runReadOnlyInspection(env, fetcher)).rejects.toThrow("Reviewed main source required");
    await expect(runReadOnlyInspection({ ...env, GITHUB_REF: "refs/heads/main", CLOUDFLARE_ACCOUNT_ID: "b".repeat(32) }, fetcher)).rejects.toThrow("Invalid inspection configuration");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the operator workflow manual, main-only, and without deployment credentials", () => {
    const workflow = readFileSync(".github/workflows/ai-gateway-readonly-inspection.yml", "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toMatch(/id-token:|write|gcloud|wrangler|pull_request_target/);
    expect(workflow).toContain("secrets.CLOUDFLARE_API_TOKEN");
  });
});
