import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createFundedRelayService,
  requireFundedRelayServiceConfig,
} from "../../packages/proxy/src/funded-main-app.js";

const root = process.cwd();

function enabledEnv(): NodeJS.ProcessEnv {
  return {
    MATRIX_FUNDED_AI_ENABLED: "true",
    CLOUDFLARE_AI_GATEWAY_URL:
      "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/matrix-funded-preview/anthropic",
    CLOUDFLARE_AI_GATEWAY_TOKEN: "g".repeat(32),
    PLATFORM_INTERNAL_URL: "https://matrix-platform-preview.example.run.app",
    AI_RELAY_CONTROL_TOKEN: "c".repeat(32),
    AI_RELAY_METADATA_SECRET: "m".repeat(32),
  };
}

describe("funded relay Cloud Run service", () => {
  it("fails closed unless the dedicated funded relay is explicitly enabled", () => {
    expect(() => requireFundedRelayServiceConfig({})).toThrow(
      "MATRIX_FUNDED_AI_ENABLED must be true for the dedicated relay service",
    );
  });

  it("exposes only a coarse health response before authenticated relay routes", async () => {
    const service = createFundedRelayService(requireFundedRelayServiceConfig(enabledEnv()));

    try {
      const health = await service.app.request("http://relay.test/health");
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });

      const unknown = await service.app.request("http://relay.test/instances");
      expect(unknown.status).toBe(404);
    } finally {
      await service.close();
    }
  });

  it("requires control auth and upstream model availability for paid-credit readiness", async () => {
    const config = requireFundedRelayServiceConfig({
      ...enabledEnv(), CLOUDFLARE_WORKERS_AI_TOKEN: "w".repeat(32),
      MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
    });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: true, result: [{ name: "@cf/zai-org/glm-5.3-flash" }],
    }), { status: 200 }));
    const service = createFundedRelayService(config, { fetchFn });
    const path = "http://relay.test/ready?model=%40cf%2Fzai-org%2Fglm-5.3-flash";
    try {
      expect((await service.app.request(path)).status).toBe(401);
      expect(fetchFn).not.toHaveBeenCalled();
      const headers = { authorization: `Bearer ${config.relayControlToken}` };
      expect((await service.app.request(path, { headers })).status).toBe(200);
      expect(fetchFn).toHaveBeenCalledWith(
        "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/models/search?search=glm-5.3-flash&per_page=10",
        expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
      );
      fetchFn.mockResolvedValueOnce(new Response(null, { status: 503 }));
      expect((await service.app.request(path, { headers })).status).toBe(503);
      fetchFn.mockResolvedValueOnce(Response.json({ success: true, result: [{ name: "@cf/other/model" }] }));
      expect((await service.app.request(path, { headers })).status).toBe(503);
      expect((await service.app.request("http://relay.test/ready?model=unknown", { headers })).status).toBe(400);
    } finally {
      await service.close();
    }
  });

  it("checks the configured Anthropic gateway model without making an inference request", async () => {
    const config = requireFundedRelayServiceConfig(enabledEnv());
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "claude-sonnet-5" }));
    const service = createFundedRelayService(config, { fetchFn });
    try {
      const response = await service.app.request("http://relay.test/ready?model=anthropic%2Fclaude-sonnet-5", {
        headers: { authorization: `Bearer ${config.relayControlToken}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ready: true });
      expect(fetchFn).toHaveBeenCalledWith(`${config.gatewayBaseUrl}/v1/models/claude-sonnet-5`,
        expect.objectContaining({ headers: {
          "cf-aig-authorization": `Bearer ${config.gatewayToken}`,
          "anthropic-version": "2023-06-01",
        } }));
    } finally {
      await service.close();
    }
  });

  it("ships an isolated image and preview-gated Cloud Run workflow", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile.ai-relay"), "utf8");
    const cloudbuild = readFileSync(join(root, "cloudbuild.ai-relay.yaml"), "utf8");
    const workflow = readFileSync(
      join(root, ".github/workflows/ai-relay-cloud-run.yml"),
      "utf8",
    );

    expect(dockerfile).toContain('CMD ["node", "packages/proxy/dist/funded-main.js"]');
    expect(dockerfile).toContain("COPY patches patches");
    expect(dockerfile).not.toContain("packages/platform");
    expect(cloudbuild).toContain("Dockerfile.ai-relay");
    expect(workflow).toContain("MATRIX_FUNDED_AI_ENABLED=true");
    expect(workflow).toContain("MATRIX_FUNDED_AI_RESERVATION_MODE=usage");
    expect(workflow).toContain("CLOUDFLARE_WORKERS_AI_TOKEN=cloudflare-workers-ai-token-preview:latest");
    for (const beta of [
      "claude-code-20250219",
      "structured-outputs-2025-11-13",
      "interleaved-thinking-2025-05-14",
      "fine-grained-tool-streaming-2025-05-14",
      "thinking-token-count-2026-05-13",
      "context-management-2025-06-27",
      "prompt-caching-scope-2026-01-05",
      "mid-conversation-system-2026-04-07",
      "effort-2025-11-24",
    ]) expect(workflow).toContain(beta);
    expect(workflow).toContain("CLOUDFLARE_AI_GATEWAY_TOKEN=cloudflare-ai-gateway-token:latest");
    expect(workflow).toContain("AI_RELAY_CONTROL_TOKEN=ai-relay-control-token:latest");
    expect(workflow).toContain("AI_RELAY_METADATA_SECRET=ai-relay-metadata-secret:latest");
    expect(workflow).toContain("--allow-unauthenticated");
    expect(workflow).toContain("traffic_flags=(--tag candidate --no-traffic)");
    expect(workflow).toContain("for _attempt in {1..10}; do");
    expect(workflow).toContain('gcloud run services describe "$AI_RELAY_CLOUD_RUN_SERVICE"');
    expect(workflow).toContain('gcloud run revisions describe "$candidate_revision"');
    expect(workflow).toContain('expected_digest="${IMAGE_DIGEST##*@}"');
    expect(workflow).toContain('candidate_digest="${candidate_image##*@}"');
    expect(workflow).toContain('[ "$candidate_digest" = "$expected_digest" ]');
    expect(workflow).toContain("sleep 3");
    expect(workflow).toContain("Candidate relay metadata did not become ready.");
    expect(workflow).toContain(
      "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6",
    );
    expect(workflow).toContain(
      "google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3",
    );
    expect(workflow).toContain(
      "google-github-actions/setup-gcloud@aa5489c8933f4cc7a4f7d45035b3b1440c9c10db # v3",
    );
    expect(workflow).toContain('curl --fail --silent --show-error --max-time 10 "$CANDIDATE_URL/health"');
    expect(workflow).not.toContain("vars.CLOUDFLARE_AI_GATEWAY_TOKEN");
    expect(workflow).not.toContain("secrets.CLOUDFLARE_AI_GATEWAY_TOKEN");
  });

  it("mounts funded control-plane configuration only when the selected platform environment enables it", () => {
    const workflow = readFileSync(
      join(root, ".github/workflows/platform-cloud-run.yml"),
      "utf8",
    );

    expect(workflow).toContain(
      "MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: ${{ vars.MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED || 'false' }}",
    );
    expect(workflow).toContain(
      "MATRIX_FUNDED_AI_RUNTIME_ENABLED: ${{ vars.MATRIX_FUNDED_AI_RUNTIME_ENABLED || 'false' }}",
    );
    expect(workflow).toContain("MATRIX_FUNDED_AI_RELAY_URL: ${{ vars.MATRIX_FUNDED_AI_RELAY_URL }}");
    expect(workflow).toContain('if [ "$MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED" = "true" ]; then');
    expect(workflow).toContain("AI_RELAY_CONTROL_TOKEN=ai-relay-control-token:latest");
    expect(workflow).toContain(
      "AI_FUNDED_CREDENTIAL_HASH_SECRET=ai-funded-credential-hash-secret:latest",
    );
    expect(workflow).toContain("${funded_ai_env_bindings}");
    expect(workflow).toContain("${funded_ai_secret_bindings}");
  });

  it("wires the same funded control plane into PR platform previews", () => {
    const workflow = readFileSync(
      join(root, ".github/workflows/preview-platform.yml"),
      "utf8",
    );

    expect(workflow).toContain(
      "MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: ${{ vars.MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED || 'false' }}",
    );
    expect(workflow).toContain(
      "MATRIX_FUNDED_AI_RUNTIME_ENABLED: ${{ vars.MATRIX_FUNDED_AI_RUNTIME_ENABLED || 'false' }}",
    );
    expect(workflow).toContain("MATRIX_FUNDED_AI_RELAY_URL: ${{ vars.MATRIX_FUNDED_AI_RELAY_URL }}");
    expect(workflow).toContain("AI_RELAY_CONTROL_TOKEN=ai-relay-control-token:latest");
    expect(workflow).toContain(
      "AI_FUNDED_CREDENTIAL_HASH_SECRET=ai-funded-credential-hash-secret:latest",
    );
    expect(workflow).toContain("${funded_ai_env_bindings}");
    expect(workflow).toContain("${funded_ai_secret_bindings}");
  });
});
