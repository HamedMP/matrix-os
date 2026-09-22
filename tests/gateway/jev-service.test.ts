import {
  JEV_EMAIL_TRIAGE_ANSWER_IDS,
  JEV_MODEL_ID,
  type JevEmailTriageResult,
} from "@matrix-os/contracts";
import { describe, expect, it, vi } from "vitest";
import type {
  JevEvaluationClaim,
  JevEvaluationStore,
} from "../../packages/gateway/src/jev/repository.js";
import {
  JevServiceError,
  createJevService,
} from "../../packages/gateway/src/jev/service.js";

const result: JevEmailTriageResult = {
  requestId: "jev_req_request_123",
  recipe: "email-triage-v1",
  model: JEV_MODEL_ID,
  latencyMs: 12,
  answers: JEV_EMAIL_TRIAGE_ANSWER_IDS.map((id) => ({ id, type: "boolean", probability: 0.5 })),
  usage: { inputTokens: 100, outputTokens: 7 },
  cost: { gatewayUsd: "0.0000042" },
};

class MemoryStore implements JevEvaluationStore {
  readonly rows = new Map<string, { hash: string; status: "pending" | "completed" | "unknown"; result?: JevEmailTriageResult }>();
  async claim(input: { ownerId: string; idempotencyKey: string; payloadHash: string }): Promise<JevEvaluationClaim> {
    const key = `${input.ownerId}:${input.idempotencyKey}`;
    const current = this.rows.get(key);
    if (!current) {
      this.rows.set(key, { hash: input.payloadHash, status: "pending" });
      return { kind: "claimed" };
    }
    if (current.hash !== input.payloadHash) return { kind: "conflict" };
    if (current.status === "completed") return { kind: "completed", result: current.result! };
    return { kind: current.status };
  }
  async complete(input: { ownerId: string; idempotencyKey: string; payloadHash: string; result: JevEmailTriageResult }) {
    this.rows.set(`${input.ownerId}:${input.idempotencyKey}`, {
      hash: input.payloadHash, status: "completed", result: input.result,
    });
  }
  async markUnknown(input: { ownerId: string; idempotencyKey: string; payloadHash: string }) {
    this.rows.set(`${input.ownerId}:${input.idempotencyKey}`, { hash: input.payloadHash, status: "unknown" });
  }
  async release(input: { ownerId: string; idempotencyKey: string; payloadHash: string }) {
    const key = `${input.ownerId}:${input.idempotencyKey}`;
    if (this.rows.get(key)?.hash === input.payloadHash) this.rows.delete(key);
  }
}

function provider() {
  return {
    enabled: true as const,
    maxRunMs: 60_000,
    getCredential: vi.fn(async () => ({
      token: `sk-matrix-funded-token_123.${"x".repeat(43)}`,
      tokenId: "token_123",
      expiresAt: "2026-09-22T11:00:00.000Z",
      relayBaseUrl: "https://relay.matrix-os.com",
      maxRunMs: 60_000,
    })),
    invalidate: vi.fn(),
    close: vi.fn(),
  };
}

describe("Jev service idempotency", () => {
  it("returns a completed owner-scoped result without a second relay dispatch", async () => {
    const store = new MemoryStore();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(result), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const service = createJevService({ store, credentialProvider: provider(), fetchFn });
    const input = { recipe: "email-triage-v1" as const, state: "hello", idempotencyKey: "thread:abc123" };

    await expect(service.evaluate("owner_a", input, new AbortController().signal)).resolves.toEqual(result);
    await expect(service.evaluate("owner_a", input, new AbortController().signal)).resolves.toEqual(result);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects reusing an idempotency key for changed evidence", async () => {
    const store = new MemoryStore();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(result), { status: 200 }));
    const service = createJevService({ store, credentialProvider: provider(), fetchFn });
    await service.evaluate("owner_a", {
      recipe: "email-triage-v1", state: "first", idempotencyKey: "thread:abc123",
    });

    await expect(service.evaluate("owner_a", {
      recipe: "email-triage-v1", state: "changed", idempotencyKey: "thread:abc123",
    })).rejects.toEqual(expect.objectContaining<Partial<JevServiceError>>({ code: "conflict" }));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("marks an ambiguous relay timeout unknown and never redispatches it", async () => {
    const store = new MemoryStore();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: "timeout" }), { status: 504 }));
    const service = createJevService({ store, credentialProvider: provider(), fetchFn });
    const input = { recipe: "email-triage-v1" as const, state: "hello", idempotencyKey: "thread:abc123" };

    await expect(service.evaluate("owner_a", input)).rejects.toEqual(
      expect.objectContaining<Partial<JevServiceError>>({ code: "unknown" }),
    );
    await expect(service.evaluate("owner_a", input)).rejects.toEqual(
      expect.objectContaining<Partial<JevServiceError>>({ code: "unknown" }),
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
