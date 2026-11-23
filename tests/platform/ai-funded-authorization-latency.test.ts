import type { KyselyPlugin } from "kysely";
import { afterEach, expect, it, vi } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { wrapPlatformDb } from "../../packages/platform/src/database/transaction-scope.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./native-platform-db-test-helper.js";

const now = new Date("2026-11-17T10:00:00.000Z");
const modelId = "@cf/zai-org/glm-5.3";

let db: PlatformDB | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  await destroyTestPlatformDb(db);
  db = undefined;
});

it.each([
  { provisioningClass: "customer", runtimeSlot: "primary", maxQueries: 26 },
  { provisioningClass: "preview", runtimeSlot: "pr-1234", maxQueries: 29 },
] as const)("bounds $provisioningClass postpaid authorization database round trips", async ({
  provisioningClass, runtimeSlot, maxQueries,
}) => {
  vi.stubEnv("ACCOUNT_DELETION_SECRET", "d".repeat(32));
  ({ db } = await createTestPlatformDb());
  let queryCount = 0;
  const counter: KyselyPlugin = {
    transformQuery({ node }) {
      return node;
    },
    async transformResult({ result }) {
      queryCount++;
      return result;
    },
  };
  const measured = db.kysely.withPlugin(counter);
  const repo = createAiFundedPolicyRepository({
    db: wrapPlatformDb(measured, measured, db.ready, () => Promise.resolve()),
    credentialHashSecret: "h".repeat(32), now: () => new Date(now),
    tokenIdFactory: () => "authorization_latency_token",
    tokenSecretFactory: () => "s".repeat(43),
  });
  const identity = { ownerId: "user_latency", machineId: "machine_latency", runtimeSlot };
  await insertUserMachine(db, {
    machineId: identity.machineId, clerkUserId: identity.ownerId,
    handle: runtimeSlot, runtimeSlot, provisioningClass, activationState: "authorized",
    status: "running", imageVersion: "test", provisionedAt: now.toISOString(),
  });
  if (provisioningClass === "preview") {
    await db.executor.insertInto("preview_runtime_allocations").values({
      machine_id: identity.machineId, owner_id: identity.ownerId, runtime_slot: runtimeSlot,
      runtime_token_epoch: 1, ai_budget_microusd: 1000, ai_request_limit: 2, ai_requests_used: 0,
      speech_request_limit: 2, speech_requests_used: 0, max_concurrency: 1,
      expires_at: "2026-11-17T11:00:00.000Z", created_at: now.toISOString(), updated_at: now.toISOString(),
    }).execute();
  }
  await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
  await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true,
    allowedModelIds: [modelId], monthlyBudgetMicrousd: 1000, expiresAt: null });
  await repo.grantCredit({ identity, entryId: "authorization_latency_grant", kind: "promotional_grant",
    amountMicrousd: 1000, sourceReference: "test-credit" });
  const { credential } = await repo.issueRuntimeCredential(identity);
  queryCount = 0;

  // Count SQL commands in the production repository entry point. No wall-clock
  // assertion depends on machine speed, network or test runner contention.
  const authorization = await repo.authorize({ credential: credential.token, requestId: "authorization_latency",
    modelId, maxCostMicrousd: 27, billingMode: "usage", billingPolicy: "postpaid" });
  expect(authorization.reservation).toMatchObject({ modelId, billingPolicy: "postpaid", reservedMicrousd: 0 });
  expect(queryCount).toBeLessThanOrEqual(maxQueries);

  queryCount = 0;
  await expect(repo.startReservation({ reservationId: authorization.reservation.reservationId, tokenId: credential.tokenId,
    executionId: "authorization_latency_execution" })).resolves.toMatchObject({ status: "in_flight",
    executionId: "authorization_latency_execution" });
  expect(queryCount).toBeLessThanOrEqual(3);
});
