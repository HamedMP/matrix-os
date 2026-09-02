import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FundedAiCredentialError,
  FundedAiCredentialUnexpectedError,
  FundedAiRuntimeConfigError,
  createFundedAiCredentialManager,
  loadFundedAiRuntimeConfig,
} from "../../packages/gateway/src/funded-ai-credential-manager.js";

const TOKEN_ID = "credential_123";
const TOKEN = `sk-matrix-funded-${TOKEN_ID}.${"A".repeat(43)}`;
const NOW = Date.parse("2026-08-30T10:00:00.000Z");

function runtimeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MATRIX_FUNDED_AI_ENABLED: "true",
    MATRIX_FUNDED_AI_RELAY_URL: "https://relay.matrix-os.com",
    PLATFORM_INTERNAL_URL: "https://platform.matrix-os.com",
    MATRIX_AUTH_TOKEN: "legacy-stable-token-must-not-authorize-funded-ai",
    MATRIX_FUNDED_AI_RUNTIME_TOKEN: "p".repeat(64),
    MATRIX_HANDLE: "alice",
    MATRIX_CLERK_USER_ID: "user_123",
    MATRIX_MACHINE_ID: "machine_123",
    MATRIX_RUNTIME_SLOT: "primary",
    MATRIX_FUNDED_AI_RUN_TIMEOUT_MS: "600000",
    ...overrides,
  };
}

function issueResponse(expiresAt = new Date(NOW + 15 * 60_000).toISOString()) {
  return {
    contractVersion: 1,
    credential: {
      token: TOKEN,
      tokenId: TOKEN_ID,
      audience: "matrix-funded-relay",
      scope: "ai:invoke",
      issuedAt: new Date(NOW).toISOString(),
      expiresAt,
    },
    identity: { ownerId: "user_123", machineId: "machine_123", runtimeSlot: "primary" },
    policy: {
      enabled: true,
      globalRevision: 1,
      runtimeRevision: 1,
      allowedModelIds: ["anthropic/claude-sonnet-5"],
      monthlyBudgetMicrousd: 5_000_000,
      checkedAt: new Date(NOW).toISOString(),
      staleAfter: new Date(NOW + 60_000).toISOString(),
    },
  };
}

describe("funded AI runtime credential manager", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is disabled by default and fails startup closed for partial or unsafe configuration", () => {
    expect(loadFundedAiRuntimeConfig({})).toBeUndefined();
    const invalidToken = () => loadFundedAiRuntimeConfig(runtimeEnv({
      MATRIX_FUNDED_AI_RUNTIME_TOKEN: "short",
    }));
    expect(invalidToken).toThrow(FundedAiRuntimeConfigError);
    expect(invalidToken).toThrow("Funded AI runtime is misconfigured");
    expect(() => loadFundedAiRuntimeConfig(runtimeEnv({ MATRIX_FUNDED_AI_RUNTIME_TOKEN: undefined })))
      .toThrow("Funded AI runtime is misconfigured");
    expect(() => loadFundedAiRuntimeConfig(runtimeEnv({ MATRIX_FUNDED_AI_RELAY_URL: "http://relay.example" })))
      .toThrow("Funded AI runtime is misconfigured");
    expect(() => loadFundedAiRuntimeConfig(runtimeEnv({ PLATFORM_INTERNAL_URL: "https://user:pass@example.com" })))
      .toThrow("Funded AI runtime is misconfigured");
    expect(() => loadFundedAiRuntimeConfig(runtimeEnv({
      MATRIX_FUNDED_AI_RELAY_URL: "https://relay.example/path;touch-pwned",
    }))).toThrow("Funded AI runtime is misconfigured");
  });

  it("derives the issue endpoint from the validated local handle", () => {
    const config = loadFundedAiRuntimeConfig(runtimeEnv());
    expect(config).toMatchObject({
      issueUrl: "https://platform.matrix-os.com/internal/containers/alice/ai/funded-credential?runtimeSlot=primary",
      relayBaseUrl: "https://relay.matrix-os.com",
      identity: { ownerId: "user_123", machineId: "machine_123", runtimeSlot: "primary" },
      maxRunMs: 600_000,
    });

    expect(loadFundedAiRuntimeConfig(runtimeEnv({ MATRIX_RUNTIME_SLOT: "staging" })))
      .toMatchObject({
        issueUrl: "https://platform.matrix-os.com/internal/containers/alice/ai/funded-credential?runtimeSlot=staging",
        identity: { runtimeSlot: "staging" },
      });
  });

  it("singleflights acquisition, caches only a sufficiently fresh token, and can invalidate it", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(issueResponse()), { status: 200 }));
    const config = loadFundedAiRuntimeConfig(runtimeEnv())!;
    const manager = createFundedAiCredentialManager(config, {
      fetchFn,
      now: () => NOW,
      random: () => 0,
      sleep: async () => {},
    });

    const [first, second] = await Promise.all([
      manager.getCredential(),
      manager.getCredential(),
    ]);
    expect(first).toEqual(second);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(config.issueUrl, expect.objectContaining({
      method: "POST",
      redirect: "error",
      headers: expect.objectContaining({ authorization: `Bearer ${"p".repeat(64)}` }),
    }));

    await manager.getCredential();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    manager.invalidate(TOKEN_ID);
    await manager.getCredential();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("rejects mismatched identity, disabled policy, oversized bodies, and near-expiry credentials safely", async () => {
    const cases: unknown[] = [
      { ...issueResponse(), identity: { ownerId: "spoof", machineId: "machine_123", runtimeSlot: "primary" } },
      { ...issueResponse(), policy: { ...issueResponse().policy, enabled: false, allowedModelIds: [] } },
      issueResponse(new Date(NOW + 60_000).toISOString()),
      "x".repeat(20_000),
    ];
    for (const value of cases) {
      const fetchFn = vi.fn(async () => new Response(
        typeof value === "string" ? value : JSON.stringify(value),
        { status: 200 },
      ));
      const manager = createFundedAiCredentialManager(loadFundedAiRuntimeConfig(runtimeEnv())!, {
        fetchFn,
        now: () => NOW,
        random: () => 0,
        sleep: async () => {},
      });
      await expect(manager.getCredential()).rejects.toEqual(expect.objectContaining({
        name: "FundedAiCredentialError",
        message: "Matrix AI is temporarily unavailable",
      }));
    }
  });

  it("retries only transient failures with bounded backoff and never exposes raw errors", async () => {
    const sleep = vi.fn(async () => {});
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED secret.internal"))
      .mockResolvedValueOnce(new Response(JSON.stringify(issueResponse()), { status: 200 }));
    const manager = createFundedAiCredentialManager(loadFundedAiRuntimeConfig(runtimeEnv())!, {
      fetchFn,
      now: () => NOW,
      random: () => 0,
      sleep,
    });
    await expect(manager.getCredential()).resolves.toMatchObject({ tokenId: TOKEN_ID });
    expect(sleep).toHaveBeenCalledWith(100, expect.any(AbortSignal));

    const denied = createFundedAiCredentialManager(loadFundedAiRuntimeConfig(runtimeEnv())!, {
      fetchFn: vi.fn(async () => new Response("owner details", { status: 403 })),
      now: () => NOW,
      random: () => 0,
      sleep: async () => {},
    });
    const error = await denied.getCredential().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FundedAiCredentialError);
    expect(String(error)).not.toContain("owner details");
  });

  it("does not disguise unexpected response-processing failures as transient service errors", async () => {
    const unexpected = new RangeError("private response reader invariant");
    const fetchFn = vi.fn(async () => new Response(new ReadableStream({
      pull() {
        throw unexpected;
      },
    }), { status: 200 }));
    const sleep = vi.fn(async () => {});
    const manager = createFundedAiCredentialManager(loadFundedAiRuntimeConfig(runtimeEnv())!, {
      fetchFn,
      now: () => NOW,
      random: () => 0,
      sleep,
    });

    const error = await manager.getCredential().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FundedAiCredentialUnexpectedError);
    expect(error).toMatchObject({
      message: "Matrix AI credential processing failed",
      cause: unexpected,
    });
    expect(String(error)).not.toContain("private response reader invariant");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("uses a request deadline and refuses use after close", async () => {
    const deadline = new AbortController();
    const fetchFn = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }));
    const manager = createFundedAiCredentialManager(loadFundedAiRuntimeConfig(runtimeEnv())!, {
      fetchFn,
      now: () => NOW,
      random: () => 0,
      makeTimeoutSignal: () => deadline.signal,
    });
    const pending = manager.getCredential();
    deadline.abort();
    await expect(pending).rejects.toBeInstanceOf(FundedAiCredentialError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    manager.close();
    await expect(manager.getCredential()).rejects.toBeInstanceOf(FundedAiCredentialError);
  });
});
