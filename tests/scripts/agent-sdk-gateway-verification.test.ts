import { describe, expect, it } from "vitest";

import {
  TARGET_AGENT_SDK_VERSION,
  buildAgentSdkTransportEnvironment,
  buildOpenRouterAuthorizeUrl,
  buildOpenRouterExchangeRequest,
  formatVerificationFailure,
  parseClaudeAuthStatus,
  verifyAgentSdkArtifacts,
  verifyCloudflareMetadata,
} from "../../scripts/spikes/agent-sdk-gateway/verification.mjs";

const REQUIRED_DECLARATIONS = `
export declare type Options = {
  abortController?: AbortController;
  agents?: Record<string, AgentDefinition>;
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  mcpServers?: Record<string, McpServerConfig>;
  resume?: string;
  skills?: string[] | 'all';
};
export declare type SDKResultSuccess = {
  structured_output?: unknown;
  modelUsage: Record<string, ModelUsage>;
};
`;

describe("Agent SDK and gateway verification contracts", () => {
  it("pins the Phase 0 target and verifies the required SDK surface", () => {
    expect(TARGET_AGENT_SDK_VERSION).toBe("0.3.251");

    expect(
      verifyAgentSdkArtifacts({
        manifest: { version: TARGET_AGENT_SDK_VERSION },
        declarationText: REQUIRED_DECLARATIONS,
        runtimeExports: ["HOOK_EVENTS", "createSdkMcpServer", "query", "tool"],
        hookEvents: ["PreToolUse"],
      }),
    ).toEqual({
      version: TARGET_AGENT_SDK_VERSION,
      checks: {
        abortController: true,
        agents: true,
        hooks: true,
        inProcessMcp: true,
        preToolUse: true,
        query: true,
        resume: true,
        skills: true,
        structuredOutput: true,
        tool: true,
        usage: true,
      },
    });
  });

  it("fails closed when the SDK version or a required capability drifts", () => {
    expect(() =>
      verifyAgentSdkArtifacts({
        manifest: { version: "0.3.250" },
        declarationText: REQUIRED_DECLARATIONS.replace("resume?: string;", ""),
        runtimeExports: ["query"],
        hookEvents: [],
      }),
    ).toThrow(/Agent SDK verification failed/);
  });

  it("normalizes Claude's machine-readable login state without retaining output", () => {
    expect(
      parseClaudeAuthStatus(
        JSON.stringify({
          loggedIn: false,
          authMethod: "none",
          apiProvider: "firstParty",
          analyticsDisabled: false,
        }),
      ),
    ).toEqual({
      loggedIn: false,
      authMethod: "none",
      apiProvider: "firstParty",
    });

    expect(() => parseClaudeAuthStatus('{"loggedIn":"yes"}')).toThrow(
      /Invalid Claude auth status/,
    );

    try {
      parseClaudeAuthStatus("not-json");
      throw new Error("expected parseClaudeAuthStatus to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(SyntaxError);
    }
  });

  it("preserves safe diagnostics while redacting unknown failure messages", () => {
    expect(
      formatVerificationFailure(
        new Error("Agent SDK verification failed: resume"),
      ),
    ).toBe("Error: Agent SDK verification failed: resume");
    expect(
      formatVerificationFailure(new Error("upstream leaked sk-secret-value")),
    ).toBe("Error: verification failed");
    expect(formatVerificationFailure("unexpected rejection")).toBe(
      "Unknown failure: verification failed",
    );
  });

  it("builds an isolated Agent SDK relay environment", () => {
    expect(
      buildAgentSdkTransportEnvironment({
        baseUrl: "https://relay.matrix.example/anthropic",
        authToken: "test-token",
      }),
    ).toEqual({
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "test-token",
      ANTHROPIC_BASE_URL: "https://relay.matrix.example/anthropic",
    });

    expect(() =>
      buildAgentSdkTransportEnvironment({
        baseUrl: "http://169.254.169.254/latest",
        authToken: "test-token",
      }),
    ).toThrow(/HTTPS/);
  });

  it("freezes OpenRouter PKCE authorization and exchange request shapes", () => {
    const callbackUrl =
      "https://app.matrix-os.com/api/ai/connections/openrouter/callback?state=owner-bound-attempt";
    const codeChallenge = "a".repeat(43);

    const authorizeUrl = new URL(
      buildOpenRouterAuthorizeUrl({ callbackUrl, codeChallenge }),
    );
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      "https://openrouter.ai/auth",
    );
    expect(authorizeUrl.searchParams.get("callback_url")).toBe(callbackUrl);
    expect(authorizeUrl.searchParams.get("code_challenge")).toBe(codeChallenge);
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");

    const exchange = buildOpenRouterExchangeRequest({
      code: "one-time-code",
      codeVerifier: "v".repeat(43),
    });
    expect(exchange.url).toBe("https://openrouter.ai/api/v1/auth/keys");
    expect(exchange.init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(String(exchange.init.body))).toEqual({
      code: "one-time-code",
      code_verifier: "v".repeat(43),
      code_challenge_method: "S256",
    });
    expect(exchange.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("requires owner-bound PKCE state and rejects unsafe callbacks", () => {
    expect(() =>
      buildOpenRouterAuthorizeUrl({
        callbackUrl: "https://app.matrix-os.com/callback",
        codeChallenge: "a".repeat(43),
      }),
    ).toThrow(/state/);

    expect(() =>
      buildOpenRouterAuthorizeUrl({
        callbackUrl: "http://example.com/callback?state=attempt",
        codeChallenge: "a".repeat(43),
      }),
    ).toThrow(/callback/);
  });

  it("keeps Cloudflare custom metadata content-free and within its five-entry limit", () => {
    expect(
      verifyCloudflareMetadata({
        matrix_user_ref: "usr_hash",
        runtime_ref: "runtime_hash",
        run_ref: "run_hash",
        access_source: "matrix_funded",
      }),
    ).toEqual({
      access_source: "matrix_funded",
      matrix_user_ref: "usr_hash",
      run_ref: "run_hash",
      runtime_ref: "runtime_hash",
    });

    expect(() =>
      verifyCloudflareMetadata({ a: "1", b: "2", c: "3", d: "4", e: "5", f: "6" }),
    ).toThrow(/five/);
    expect(() => verifyCloudflareMetadata({ prompt: "secret" })).toThrow(
      /content-free/,
    );
  });
});
