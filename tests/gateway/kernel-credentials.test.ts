import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildKernelEnv,
  resolveKernelCredentialMode,
  resolveKernelCredentialSources,
} from "../../packages/gateway/src/kernel-credentials.js";

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
    )).resolves.toMatchObject({
      ANTHROPIC_API_KEY: "platform-key",
      ANTHROPIC_BASE_URL: "https://relay.example.com",
    });
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
    });

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
