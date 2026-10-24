import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("GitHub integration startup wiring", () => {
  it("constructs the native provider client and broker only from validated config", async () => {
    const source = await readFile("packages/platform/src/platform-startup.ts", "utf8");
    expect(source).toContain("resolveGitHubIntegrationConfig");
    expect(source).toContain("githubIntegrationConfig");
    expect(source).toContain("new githubOAuthModule.GitHubOAuthClient");
    expect(source).toContain("new githubIntegrationModule.GitHubIntegrationBroker");
    expect(source).toContain("parseGitHubCredentialEncryptionKey");
    expect(source).toContain("githubBroker");
    expect(source).toContain("registerCustomMcpStartupCleanup(closeIntegrationDb)");
    expect(source).toContain("integrationDbShutdown?.()");
  });

  it("protects the public callback with account-deletion admission bound to encrypted state", async () => {
    const source = await readFile("packages/platform/src/platform-startup.ts", "utf8");
    expect(source).toContain("githubCallbackRoutes.use('/oauth/github/callback'");
    expect(source).toContain("decryptGitHubOAuthState");
    expect(source).toContain("getUserById(decoded.userId)");
  });
});
