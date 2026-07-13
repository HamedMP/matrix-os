import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildKernelEnv,
  resolveKernelCredentialMode,
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
});
