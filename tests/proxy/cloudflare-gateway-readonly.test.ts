import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { inspectGatewayMetadata, runReadOnlyInspection } from "../../scripts/ops/cloudflare-gateway-readonly.mjs";

const account = "a".repeat(32);
const token = "private-operator-credential-".repeat(2);
const config = { accountId: account, token, gatewayId: "matrix-funded-production" };
const inspectionEnv = {
  GITHUB_REF: "refs/heads/main", CLOUDFLARE_API_TOKEN: token,
  CLOUDFLARE_ACCOUNT_ID: account,
  CLOUDFLARE_AI_GATEWAY_URL: `https://gateway.ai.cloudflare.com/v1/${account}/matrix-funded-production/anthropic`,
};

function gatewayResponse(url: string) {
  return Response.json({ success: true, result: { id: url.split("/").at(-1) } });
}

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

  it.each(["user", "account"])("identifies the %s token without logging credentials or arbitrary response fields", async ownership => {
    const id = "c".repeat(32);
    const fetcher = vi.fn(async (url: string, _options?: RequestInit) => {
      if (!url.endsWith("/tokens/verify")) return gatewayResponse(url);
      if (ownership === "account" && url.includes("/user/")) {
        return Response.json({ success: false, errors: [{ message: token }] }, { status: 403 });
      }
      return Response.json({ success: true, result: { id, status: "active", value: token, name: token } });
    });
    const result = await runReadOnlyInspection(inspectionEnv, fetcher);
    expect(result.tokenIdentity).toEqual({ verified: true, ownership, id, status: "active" });
    expect(result.results.map((gateway: { readable: boolean }) => gateway.readable)).toEqual([true, true]);
    const verificationUrls = fetcher.mock.calls.map(([url]) => url).filter(url => url.endsWith("/tokens/verify"));
    expect(verificationUrls).toEqual(ownership === "user"
      ? ["https://api.cloudflare.com/client/v4/user/tokens/verify"]
      : ["https://api.cloudflare.com/client/v4/user/tokens/verify", `https://api.cloudflare.com/client/v4/accounts/${account}/tokens/verify`]);
    for (const [, options] of fetcher.mock.calls) {
      expect(options).toMatchObject({ method: "GET", redirect: "error", signal: expect.any(AbortSignal),
        headers: { authorization: `Bearer ${token}` } });
    }
    expect(JSON.stringify(result)).not.toMatch(/private-|Bearer|value|name/);
  });

  it.each([
    { id: "c".repeat(32), status: token },
    { id: token, status: "active" },
    { id: "c".repeat(32), status: "unknown" },
  ])("rejects malformed token identity fields while preserving gateway diagnostics", async identity => {
    const fetcher = vi.fn(async (url: string) => url.endsWith("/tokens/verify")
      ? Response.json({ success: true, result: identity }) : gatewayResponse(url));
    const result = await runReadOnlyInspection(inspectionEnv, fetcher);
    expect(result.tokenIdentity).toMatchObject({ verified: false });
    expect(result.results).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it.each(["disabled", "expired"])("reports a verified %s token status without claiming gateway access", async status => {
    const fetcher = vi.fn(async (url: string) => url.endsWith("/tokens/verify")
      ? Response.json({ success: true, result: { id: "c".repeat(32), status } })
      : Response.json({ success: false, errors: [{ code: 10000, message: token }] }, { status: 403 }));
    const result = await runReadOnlyInspection(inspectionEnv, fetcher);
    expect(result.tokenIdentity).toEqual({ verified: true, ownership: "user", id: "c".repeat(32), status });
    expect(result.results.map((gateway: { readable: boolean }) => gateway.readable)).toEqual([false, false]);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it.each(["network", "timeout", "oversized", "invalid-json", "denied"])("continues the gateway checks after %s token verification failures", async failure => {
    const fetcher = vi.fn(async (url: string) => {
      if (!url.endsWith("/tokens/verify")) return gatewayResponse(url);
      if (failure === "network") throw new TypeError(token);
      if (failure === "timeout") throw new DOMException(token, "TimeoutError");
      if (failure === "oversized") return new Response("x".repeat(65537));
      if (failure === "invalid-json") return new Response(token);
      return Response.json({ success: false, errors: [{ message: token }] }, { status: 403 });
    });
    const result = await runReadOnlyInspection(inspectionEnv, fetcher);
    expect(result.tokenIdentity).toMatchObject({ verified: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(result.results.map((gateway: { readable: boolean }) => gateway.readable)).toEqual([true, true]);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("rejects an invalid credential before token verification or gateway requests", async () => {
    const fetcher = vi.fn();
    await expect(runReadOnlyInspection({ ...inspectionEnv, CLOUDFLARE_API_TOKEN: "" }, fetcher))
      .rejects.toThrow("Invalid inspection configuration");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { identity: true, gateways: true, exitCode: 0 },
    { identity: true, gateways: false, exitCode: 1 },
    { identity: false, gateways: true, exitCode: 1 },
  ])("prints a safe CLI report and exits $exitCode with identity=$identity and gateways=$gateways", scenario => {
    const preload = `globalThis.fetch = async (url) => {
      if (url.endsWith('/tokens/verify')) return Response.json({
        success: ${scenario.identity},
        result: { id: '${"c".repeat(32)}', status: 'active', value: process.env.CLOUDFLARE_API_TOKEN },
        errors: [{ message: process.env.CLOUDFLARE_API_TOKEN }],
      }, { status: ${scenario.identity ? 200 : 403} });
      return Response.json({ success: ${scenario.gateways}, result: { id: url.split('/').at(-1) } },
        { status: ${scenario.gateways ? 200 : 403} });
    };`;
    const child = spawnSync(process.execPath, [
      "--import", `data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`,
      "scripts/ops/cloudflare-gateway-readonly.mjs",
    ], { env: { ...process.env, ...inspectionEnv }, encoding: "utf8", timeout: 10_000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(scenario.exitCode);
    const report = JSON.parse(child.stdout);
    expect(report.tokenIdentity.verified).toBe(scenario.identity);
    expect(report.results).toHaveLength(2);
    expect(child.stdout + child.stderr).not.toContain(token);
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
