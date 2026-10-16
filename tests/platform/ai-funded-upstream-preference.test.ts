import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAiFundedUpstreamPreferenceRepository,
  loadAiFundedUpstreamPreferenceConfig,
} from "../../packages/platform/src/ai-funded-upstream-preference.js";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./native-platform-db-test-helper.js";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const VALID_THROUGH = "2026-10-21T12:00:00.000Z";
const OWNER_IDS = ["user_nima", "user_hamed", "user_stefan", "user_yuhan"];
const MODEL_ID = "anthropic/claude-sonnet-5";

describe("funded AI upstream preference", () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  function repository(probeReady = true) {
    const observeBedrock = async () => ({
      ready: probeReady,
      checkedAt: NOW.toISOString(),
      staleAfter: new Date(NOW.getTime() + 30_000).toISOString(),
      ...(probeReady ? { priceValidThrough: VALID_THROUGH } : {}),
    });
    return createAiFundedUpstreamPreferenceRepository({
      db,
      now: () => NOW,
      selectionSecret: "upstream-selection-secret-for-tests-123",
      config: {
        enabled: true,
        ownerIds: OWNER_IDS,
        bedrockModelIds: [MODEL_ID],
        validThrough: VALID_THROUGH,
      },
      readCachedBedrock: observeBedrock,
    });
  }

  it("loads only a bounded immutable-owner cohort and expires fail closed", () => {
    expect(loadAiFundedUpstreamPreferenceConfig({
      AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED: "true",
      AI_FUNDED_UPSTREAM_PREFERENCE_OWNER_IDS: OWNER_IDS.join(","),
      AI_FUNDED_BEDROCK_MODEL_IDS: JSON.stringify([MODEL_ID]),
      AI_FUNDED_UPSTREAM_PREFERENCE_VALID_THROUGH: VALID_THROUGH,
    }, NOW)).toEqual({
      enabled: true,
      ownerIds: OWNER_IDS,
      bedrockModelIds: [MODEL_ID],
      validThrough: VALID_THROUGH,
    });
    expect(loadAiFundedUpstreamPreferenceConfig({}, NOW)).toEqual({ enabled: false });
    expect(() => loadAiFundedUpstreamPreferenceConfig({
      AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED: "true",
      AI_FUNDED_UPSTREAM_PREFERENCE_OWNER_IDS: "Nima,Hamed,Stefan,Yuhan",
      AI_FUNDED_BEDROCK_MODEL_IDS: JSON.stringify([MODEL_ID]),
      AI_FUNDED_UPSTREAM_PREFERENCE_VALID_THROUGH: VALID_THROUGH,
    }, NOW)).toThrow(/misconfigured/i);
    expect(loadAiFundedUpstreamPreferenceConfig({
      AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED: "true",
      AI_FUNDED_UPSTREAM_PREFERENCE_OWNER_IDS: OWNER_IDS.join(","),
      AI_FUNDED_BEDROCK_MODEL_IDS: JSON.stringify([MODEL_ID]),
      AI_FUNDED_UPSTREAM_PREFERENCE_VALID_THROUGH: NOW.toISOString(),
    }, NOW)).toEqual({ enabled: false });
  });

  it("hides the capability from unentitled owners and defaults entitled owners to Cloudflare", async () => {
    const repo = repository();
    await expect(repo.getPreference("user_outsidecohort")).resolves.toBeNull();
    await expect(repo.getPreference("user_nima")).resolves.toEqual({
      selectedUpstream: "cloudflare",
      revision: 0,
      updatedAt: null,
      validThrough: VALID_THROUGH,
    });
  });

  it("atomically updates the preference and its audit with optimistic concurrency", async () => {
    const repo = repository();
    await expect(repo.setPreference({
      ownerId: "user_nima",
      actorOwnerId: "user_nima",
      idempotencyKey: "preference_1",
      expectedRevision: 0,
      selectedUpstream: "aws_bedrock",
    })).resolves.toMatchObject({ selectedUpstream: "aws_bedrock", revision: 1 });

    await expect(repo.setPreference({
      ownerId: "user_nima",
      actorOwnerId: "user_nima",
      idempotencyKey: "preference_2",
      expectedRevision: 0,
      selectedUpstream: "cloudflare",
    })).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(repo.setPreference({
      ownerId: "user_outsidecohort",
      actorOwnerId: "user_outsidecohort",
      idempotencyKey: "preference_3",
      expectedRevision: 0,
      selectedUpstream: "aws_bedrock",
    })).rejects.toMatchObject({ code: "not_found" });

    expect(await db.executor.selectFrom("ai_funded_upstream_preference_audit").selectAll().execute())
      .toEqual([expect.objectContaining({
        owner_id: "user_nima",
        actor_owner_id: "user_nima",
        previous_upstream: "cloudflare",
        selected_upstream: "aws_bedrock",
        previous_revision: 0,
        revision: 1,
      })]);
  });

  it("selects Bedrock only for a current entitled preference, exact model, and healthy authenticated probe", async () => {
    const repo = repository();
    await repo.setPreference({ ownerId: "user_nima", actorOwnerId: "user_nima", idempotencyKey: "preference_1",
      expectedRevision: 0, selectedUpstream: "aws_bedrock" });

    const selected = await repo.resolveUpstream({ ownerId: "user_nima", modelId: MODEL_ID });
    expect(selected).toMatchObject({
      upstream: "aws_bedrock",
      preferenceRevision: 1,
      checkedAt: NOW.toISOString(),
      staleAfter: new Date(NOW.getTime() + 30_000).toISOString(),
    });
    expect(selected.proof).toMatch(/^[a-f0-9]{64}$/);
    await expect(repo.verifyUpstream({ ownerId: "user_nima", modelId: MODEL_ID, selection: selected }))
      .resolves.toBe(true);
    await expect(repo.verifyUpstream({ ownerId: "user_hamed", modelId: MODEL_ID, selection: selected }))
      .resolves.toBe(false);

    await expect(repo.resolveUpstream({ ownerId: "user_nima", modelId: "anthropic/other" }))
      .resolves.toMatchObject({ upstream: "cloudflare" });
    await expect(repository(false).resolveUpstream({ ownerId: "user_nima", modelId: MODEL_ID }))
      .resolves.toMatchObject({ upstream: "cloudflare" });
    await expect(repo.resolveUpstream({ ownerId: "user_outsidecohort", modelId: MODEL_ID }))
      .resolves.toMatchObject({ upstream: "cloudflare" });
  });

  it("accepts a fresh Bedrock observation timestamped after the probe begins", async () => {
    let observedNow = NOW.getTime();
    const repo = createAiFundedUpstreamPreferenceRepository({
      db,
      now: () => new Date(observedNow),
      selectionSecret: "upstream-selection-secret-for-tests-123",
      config: {
        enabled: true,
        ownerIds: OWNER_IDS,
        bedrockModelIds: [MODEL_ID],
        validThrough: VALID_THROUGH,
      },
      readCachedBedrock: async () => {
        observedNow += 1_000;
        return {
          ready: true,
          checkedAt: new Date(observedNow).toISOString(),
          staleAfter: new Date(observedNow + 30_000).toISOString(),
          priceValidThrough: VALID_THROUGH,
        };
      },
    });
    await repo.setPreference({ ownerId: "user_nima", actorOwnerId: "user_nima",
      idempotencyKey: "fresh_probe", expectedRevision: 0, selectedUpstream: "aws_bedrock" });

    await expect(repo.resolveUpstream({ ownerId: "user_nima", modelId: MODEL_ID }))
      .resolves.toMatchObject({ upstream: "aws_bedrock", checkedAt: "2026-10-14T12:00:01.000Z" });
  });

  it("replays an applied preference mutation by durable idempotency key", async () => {
    const repo = repository();
    const mutation = { ownerId: "user_nima", actorOwnerId: "user_nima",
      idempotencyKey: "durable_retry", expectedRevision: 0, selectedUpstream: "aws_bedrock" as const };
    await expect(repo.setPreference(mutation)).resolves.toMatchObject({ revision: 1 });
    await expect(repo.setPreference(mutation)).resolves.toMatchObject({ revision: 1 });
    expect(await db.executor.selectFrom("ai_funded_upstream_preference_audit")
      .selectAll().execute()).toHaveLength(1);
    await expect(repo.setPreference({ ...mutation, selectedUpstream: "cloudflare" }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
  });
});
