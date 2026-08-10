import type { ProviderUsageSourceSummary } from "@matrix-os/contracts";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CodingAgentProviderUsageSnapshotRepository,
} from "../../packages/gateway/src/coding-agents/provider-usage-repository.js";

const ownerId = "user_a";
const runtimeId = "rt_primary";

function codexSnapshot(
  overrides: Partial<ProviderUsageSourceSummary> = {},
): ProviderUsageSourceSummary {
  return {
    id: "openai-chatgpt",
    displayName: "OpenAI / ChatGPT",
    linkedAgentProviderIds: ["codex"],
    state: "available",
    accuracy: "provider_reported",
    windows: [
      {
        id: "primary",
        label: "5-hour window",
        remainingPercent: 73,
        resetsAt: "2026-08-10T16:00:00.000Z",
        windowMinutes: 300,
      },
    ],
    observedAt: "2026-08-10T12:00:00.000Z",
    expiresAt: "2026-08-10T12:05:00.000Z",
    setupActions: [],
    ...overrides,
  };
}

describe("CodingAgentProviderUsageSnapshotRepository", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let repository: CodingAgentProviderUsageSnapshotRepository;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    repository = new CodingAgentProviderUsageSnapshotRepository(pglite.dialect);
    await repository.bootstrap();
  });

  afterEach(async () => {
    await repository.destroy();
  });

  it("bootstraps its table idempotently", async () => {
    await repository.bootstrap();

    await expect(repository.list({ ownerId, runtimeId })).resolves.toEqual([]);
  });

  it("stores and returns only the normalized provider usage contract", async () => {
    await repository.upsert({ ownerId, runtimeId, source: codexSnapshot() });

    const [source] = await repository.list({ ownerId, runtimeId });
    expect(source).toEqual(codexSnapshot());
    expect(Object.keys(source ?? {}).sort()).toEqual([
      "accuracy",
      "displayName",
      "expiresAt",
      "id",
      "linkedAgentProviderIds",
      "observedAt",
      "setupActions",
      "state",
      "windows",
    ]);
  });

  it("atomically replaces the same owner, runtime, and source row", async () => {
    await repository.upsert({ ownerId, runtimeId, source: codexSnapshot() });
    await repository.upsert({
      ownerId,
      runtimeId,
      source: codexSnapshot({
        windows: [{
          id: "primary",
          label: "5-hour window",
          remainingPercent: 41,
        }],
        observedAt: "2026-08-10T12:03:00.000Z",
        expiresAt: "2026-08-10T12:08:00.000Z",
      }),
    });

    const sources = await repository.list({ ownerId, runtimeId });
    expect(sources).toHaveLength(1);
    expect(sources[0]?.windows[0]?.remainingPercent).toBe(41);
  });

  it("isolates identical source ids across owner and runtime scopes", async () => {
    await repository.upsert({ ownerId, runtimeId, source: codexSnapshot() });
    await repository.upsert({
      ownerId: "user_b",
      runtimeId,
      source: codexSnapshot({ displayName: "Owner B quota" }),
    });
    await repository.upsert({
      ownerId,
      runtimeId: "rt_secondary",
      source: codexSnapshot({ displayName: "Secondary runtime quota" }),
    });

    await expect(repository.list({ ownerId, runtimeId })).resolves.toEqual([
      codexSnapshot(),
    ]);
    await expect(repository.list({ ownerId: "user_b", runtimeId })).resolves.toEqual([
      codexSnapshot({ displayName: "Owner B quota" }),
    ]);
    await expect(repository.list({ ownerId, runtimeId: "rt_secondary" })).resolves.toEqual([
      codexSnapshot({ displayName: "Secondary runtime quota" }),
    ]);
  });

  it("rejects snapshots containing fields outside the safe shared contract", async () => {
    const unsafe = {
      ...codexSnapshot(),
      accessToken: "secret-value",
    } as unknown as ProviderUsageSourceSummary;

    await expect(repository.upsert({ ownerId, runtimeId, source: unsafe }))
      .rejects.toThrow();
  });

  it("does not destroy an injected shared Kysely instance", async () => {
    const wrapper = new CodingAgentProviderUsageSnapshotRepository(repository.kysely);

    await wrapper.destroy();

    await expect(repository.list({ ownerId, runtimeId })).resolves.toEqual([]);
  });
});
