import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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

  it("ships an isolated image and preview-gated Cloud Run workflow", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile.ai-relay"), "utf8");
    const cloudbuild = readFileSync(join(root, "cloudbuild.ai-relay.yaml"), "utf8");
    const workflow = readFileSync(
      join(root, ".github/workflows/ai-relay-cloud-run.yml"),
      "utf8",
    );

    expect(dockerfile).toContain('CMD ["node", "packages/proxy/dist/funded-main.js"]');
    expect(dockerfile).not.toContain("packages/platform");
    expect(cloudbuild).toContain("Dockerfile.ai-relay");
    expect(workflow).toContain("MATRIX_FUNDED_AI_ENABLED=true");
    expect(workflow).toContain("CLOUDFLARE_AI_GATEWAY_TOKEN=cloudflare-ai-gateway-token:latest");
    expect(workflow).toContain("AI_RELAY_CONTROL_TOKEN=ai-relay-control-token:latest");
    expect(workflow).toContain("AI_RELAY_METADATA_SECRET=ai-relay-metadata-secret:latest");
    expect(workflow).toContain("--allow-unauthenticated");
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
