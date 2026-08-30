import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildKernelCredentialLaunch,
  buildKernelEnv,
  resolveKernelCredentialMode,
  resolveKernelCredentialSources,
} from "../../packages/gateway/src/kernel-credentials.js";
import type { MatrixFundedCredentialProvider } from "../../packages/gateway/src/funded-ai-credential-manager.js";

function fundedProvider(): MatrixFundedCredentialProvider {
  return {
    enabled: true,
    maxRunMs: 600_000,
    getCredential: async () => ({
      token: `sk-matrix-funded-credential_123.${"A".repeat(43)}`,
      tokenId: "credential_123",
      expiresAt: "2026-08-30T10:15:00.000Z",
      relayBaseUrl: "https://relay.matrix-os.com",
      maxRunMs: 600_000,
    }),
    invalidate: () => {},
    close: () => {},
  };
}

describe("kernel credential resolution", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = mkdtempSync(join(tmpdir(), "kernel-credentials-"));
    mkdirSync(join(homePath, "system"), { recursive: true });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("prefers an owner API key over a Claude login", async () => {
    writeFileSync(
      join(homePath, "system/config.json"),
      JSON.stringify({ kernel: { anthropicApiKey: "sk-ant-owner-key" } }),
    );
    writeFileSync(
      join(homePath, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "oauth-account" } }),
    );

    expect(await resolveKernelCredentialMode(homePath)).toBe("api_key");
    await expect(buildKernelEnv(homePath, { ANTHROPIC_API_KEY: "platform-key" })).resolves.toMatchObject({
      ANTHROPIC_API_KEY: "sk-ant-owner-key",
    });
  });

  it("uses a Claude login before the platform environment", async () => {
    writeFileSync(
      join(homePath, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "oauth-account" } }),
    );

    expect(await resolveKernelCredentialMode(homePath)).toBe("claude_login");
    const env = await buildKernelEnv(homePath, {
      ANTHROPIC_API_KEY: "platform-key",
      ANTHROPIC_BASE_URL: "https://proxy.example.com",
    });
    expect(env?.HOME).toBe(homePath);
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env?.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("uses platform mode when owner credentials are absent", async () => {
    expect(await resolveKernelCredentialMode(homePath)).toBe("platform");
    await expect(buildKernelEnv(homePath, { ANTHROPIC_API_KEY: "platform-key" })).resolves.toBeUndefined();
  });

  it("honors an explicit Matrix-funded source even when owner credentials exist", async () => {
    writeFileSync(
      join(homePath, "system/config.json"),
      JSON.stringify({ kernel: { anthropicApiKey: "sk-ant-owner-key" } }),
    );

    await expect(buildKernelEnv(
      homePath,
      {
        ANTHROPIC_API_KEY: "platform-key",
        ANTHROPIC_BASE_URL: "https://relay.example.com",
        MATRIX_FUNDED_AI_ENABLED: "1",
      },
      "matrix_included",
      fundedProvider(),
    )).resolves.toMatchObject({
      ANTHROPIC_API_KEY: expect.stringMatching(/^sk-matrix-funded-/),
      ANTHROPIC_BASE_URL: "https://relay.matrix-os.com",
    });
  });

  it("never treats a static platform key as Matrix-funded access", async () => {
    const env = {
      ANTHROPIC_API_KEY: "legacy-platform-key",
      ANTHROPIC_BASE_URL: "https://legacy.example",
      MATRIX_FUNDED_AI_ENABLED: "1",
    };
    await expect(buildKernelEnv(homePath, env, "matrix_included"))
      .rejects.toThrow("Selected AI access is unavailable");
    await expect(resolveKernelCredentialSources(homePath, env)).resolves.toMatchObject({
      matrixIncluded: { state: "disabled" },
    });
  });

  it("returns a bounded funded launch without exposing token metadata in source snapshots", async () => {
    const provider = fundedProvider();
    const launch = await buildKernelCredentialLaunch(homePath, {
      MATRIX_AUTH_TOKEN: "platform-auth-secret",
      UPGRADE_TOKEN: "upgrade-secret",
      MATRIX_CODE_PROXY_TOKEN: "code-proxy-secret",
      AI_RELAY_CONTROL_TOKEN: "relay-control-secret",
      CF_AIG_AUTHORIZATION: "cloudflare-secret",
    }, "matrix_included", provider);
    expect(launch).toMatchObject({
      fundedRunTimeoutMs: 600_000,
      env: {
        ANTHROPIC_API_KEY: expect.stringMatching(/^sk-matrix-funded-/),
        ANTHROPIC_BASE_URL: "https://relay.matrix-os.com",
      },
    });
    expect(launch.env).not.toHaveProperty("MATRIX_AUTH_TOKEN");
    expect(launch.env).not.toHaveProperty("UPGRADE_TOKEN");
    expect(launch.env).not.toHaveProperty("MATRIX_CODE_PROXY_TOKEN");
    expect(launch.env).not.toHaveProperty("AI_RELAY_CONTROL_TOKEN");
    expect(launch.env).not.toHaveProperty("CF_AIG_AUTHORIZATION");
    const sources = await resolveKernelCredentialSources(homePath, {}, provider);
    expect(sources.matrixIncluded.state).toBe("ready");
    expect(JSON.stringify(sources)).not.toContain("credential_123");
  });

  it("honors an explicit owner source and fails closed when it is unavailable", async () => {
    writeFileSync(
      join(homePath, "system/config.json"),
      JSON.stringify({ kernel: { anthropicApiKey: "sk-ant-owner-key" } }),
    );

    await expect(buildKernelEnv(
      homePath,
      { ANTHROPIC_API_KEY: "platform-key" },
      "owner_anthropic_key",
    )).resolves.toMatchObject({ ANTHROPIC_API_KEY: "sk-ant-owner-key" });

    await expect(buildKernelEnv(
      homePath,
      { ANTHROPIC_API_KEY: "platform-key" },
      "owner_anthropic_profile",
    )).rejects.toThrow("Selected AI access is unavailable");
  });

  it("reports Matrix and owner credential sources independently without secrets", async () => {
    writeFileSync(
      join(homePath, "system/config.json"),
      JSON.stringify({ kernel: { anthropicApiKey: "sk-ant-owner-key" } }),
    );

    const sources = await resolveKernelCredentialSources(homePath, {
      ANTHROPIC_API_KEY: "platform-key",
      MATRIX_FUNDED_AI_ENABLED: "1",
    }, fundedProvider());

    expect(sources).toEqual({
      selectedMode: "api_key",
      selectedAccessSourceId: "owner_anthropic_key",
      matrixIncluded: { state: "ready" },
      ownerApiKey: { state: "unverified" },
      ownerProfile: { state: "setup_required" },
    });
    expect(JSON.stringify(sources)).not.toContain("owner-key");
    expect(JSON.stringify(sources)).not.toContain("platform-key");
  });

  it("does not infer Matrix-funded readiness from a legacy platform key", async () => {
    await expect(resolveKernelCredentialSources(homePath, {
      ANTHROPIC_API_KEY: "legacy-platform-key",
      MATRIX_FUNDED_AI_ENABLED: "0",
    })).resolves.toMatchObject({
      selectedMode: "platform",
      matrixIncluded: { state: "disabled" },
    });
  });

  it("keeps a discovered owner profile unverified until a bounded probe succeeds", async () => {
    writeFileSync(
      join(homePath, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "oauth-account" } }),
    );

    await expect(resolveKernelCredentialSources(homePath, {})).resolves.toEqual({
      selectedMode: "claude_login",
      selectedAccessSourceId: "owner_anthropic_profile",
      matrixIncluded: { state: "disabled" },
      ownerApiKey: { state: "setup_required" },
      ownerProfile: { state: "unverified" },
    });
  });

  it("distinguishes malformed and unreadable owner credential files", async () => {
    writeFileSync(join(homePath, "system/config.json"), "{not-json");
    mkdirSync(join(homePath, ".claude.json"));

    await expect(resolveKernelCredentialSources(homePath, {})).resolves.toEqual({
      selectedMode: "platform",
      selectedAccessSourceId: "matrix_included",
      matrixIncluded: { state: "disabled" },
      ownerApiKey: { state: "invalid" },
      ownerProfile: { state: "unavailable" },
    });
  });
});
