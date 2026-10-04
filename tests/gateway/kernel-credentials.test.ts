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

const requestedClasses: string[] = [];

function fundedProvider(): MatrixFundedCredentialProvider {
  return {
    enabled: true,
    maxRunMs: 600_000,
    getCredential: async ({ requestClass }) => {
      requestedClasses.push(requestClass);
      return {
        token: `sk-matrix-funded-credential_123.${"A".repeat(43)}`,
        tokenId: "credential_123",
        expiresAt: "2026-08-30T10:15:00.000Z",
        relayBaseUrl: "https://relay.matrix-os.com",
        maxRunMs: 600_000,
        requestClass,
      };
    },
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
    await expect(buildKernelEnv(homePath, { ANTHROPIC_API_KEY: "platform-key" })).rejects.toThrow("Selected AI access is unavailable");
  });

  it("rejects an explicit Matrix-funded source even when owner credentials exist", async () => {
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
    )).rejects.toThrow("Selected AI access is unavailable");
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

  it("retains readonly funded source metadata without acquiring a launch", async () => {
    requestedClasses.length = 0;
    const provider = fundedProvider();
    await expect(buildKernelCredentialLaunch(homePath, {}, "matrix_included", provider, { requestClass: "interactive" })).rejects.toThrow();
    const sources = await resolveKernelCredentialSources(homePath, {}, provider);
    expect(sources.matrixIncluded.state).toBe("ready");
    expect(JSON.stringify(sources)).not.toContain("credential_123");
    expect(requestedClasses).toEqual([]);
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

  it.each([
    ["key", undefined], ["key", "owner_anthropic_key"],
    ["profile", undefined], ["profile", "owner_anthropic_profile"],
  ] as const)("isolates %s owner launch credentials for source %s from ambient auth", async (kind, source) => {
    if (kind === "key") {
      writeFileSync(join(homePath, "system/config.json"), JSON.stringify({ kernel: { anthropicApiKey: "owner-key" } }));
    } else {
      writeFileSync(join(homePath, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "owner-account" } }));
    }
    const launch = await buildKernelCredentialLaunch(homePath, {
      ANTHROPIC_API_KEY: "ambient-key",
      ANTHROPIC_BASE_URL: "https://ambient.example",
      ANTHROPIC_AUTH_TOKEN: "ambient-token",
      CLAUDE_CODE_OAUTH_TOKEN: "ambient-oauth-token",
      ANTHROPIC_CUSTOM_HEADERS: "x-matrix-funded-claim-key: old-run",
      PATH: "/owner/tools", OWNER_SETTING: "preserved",
    }, source, fundedProvider(), { requestClass: "interactive" });
    expect(launch.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(launch.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(launch.env).not.toHaveProperty("ANTHROPIC_CUSTOM_HEADERS");
    expect(launch.env).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(launch.env).toMatchObject({ PATH: "/owner/tools", OWNER_SETTING: "preserved" });
    if (kind === "key") expect(launch.env?.ANTHROPIC_API_KEY).toBe("owner-key");
    else {
      expect(launch.env?.HOME).toBe(homePath);
      expect(launch.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    }
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

describe("funded kernel launch classes", () => {
  let homePath: string;
  beforeEach(() => {
    homePath = mkdtempSync(join(tmpdir(), "kernel-funding-"));
    mkdirSync(join(homePath, "system"), { recursive: true });
    requestedClasses.length = 0;
  });
  afterEach(() => rmSync(homePath, { recursive: true, force: true }));

  it.each(["interactive", "background"] as const)("rejects %s funded SDK launches before credential acquisition", async (requestClass) => {
    await expect(buildKernelCredentialLaunch(homePath, {}, "matrix_included", fundedProvider(), {
      requestClass, claimKey: "run_abc:turn.1",
    })).rejects.toThrow();
    expect(requestedClasses).toEqual([]);
  });

  it("does not send funded claim headers with owner SDK access", async () => {
    writeFileSync(join(homePath, "system/config.json"), JSON.stringify({ kernel: { anthropicApiKey: "sk-ant-owner" } }));
    const owner = await buildKernelCredentialLaunch(homePath, {}, "owner_anthropic_key", fundedProvider(), {
      requestClass: "interactive", claimKey: "run_abc",
    });
    expect(owner.env).not.toHaveProperty("ANTHROPIC_CUSTOM_HEADERS");
    expect(requestedClasses).toEqual([]);
  });
});
