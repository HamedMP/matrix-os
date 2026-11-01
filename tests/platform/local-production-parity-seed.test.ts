import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  getUserMachine,
  insertUserMachine,
  type NewUserMachine,
  type PlatformDB,
} from "../../packages/platform/src/db.js";
import {
  seedLocalParityMachine,
  type LocalParitySeedState,
} from "../../scripts/dev-production-parity-seed.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const localMachine = (machineId: string, overrides: Partial<NewUserMachine> = {}): NewUserMachine => ({
  machineId,
  clerkUserId: "user_local",
  handle: "local",
  runtimeSlot: "primary",
  provisioningClass: "customer",
  hetznerServerId: 424242,
  status: "provisioning",
  imageVersion: "local-working-tree",
  targetBundleVersion: "local-working-tree",
  targetBundleSha256: "old-bundle",
  provisionedAt: "2026-09-28T00:00:00.000Z",
  activationState: "authorized",
  ...overrides,
});

const seedState = (overrides: Partial<LocalParitySeedState> = {}): LocalParitySeedState => ({
  machineId: "machine-new",
  previousMachineId: "machine-old",
  clerkUserId: "user_local",
  handle: "local",
  hetznerServerId: 424242,
  registrationToken: "registration-token",
  registrationTokenExpiresAt: "2026-09-29T12:00:00.000Z",
  bundleSha256: "new-bundle",
  ...overrides,
});

describe("local production parity database seed", () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  it("atomically replaces only the exact prior disposable machine", async () => {
    await insertUserMachine(db, localMachine("machine-old"));
    await insertUserMachine(db, localMachine("foreign-secondary", {
      clerkUserId: "user_foreign",
      runtimeSlot: "secondary",
      imageVersion: "production",
      targetBundleVersion: "production",
      hetznerServerId: 777,
    }));

    await seedLocalParityMachine(db, seedState());

    await expect(getUserMachine(db, "machine-old")).resolves.toBeUndefined();
    await expect(getUserMachine(db, "foreign-secondary")).resolves.toMatchObject({
      clerkUserId: "user_foreign",
      handle: "local",
      runtimeSlot: "secondary",
    });
    await expect(getUserMachine(db, "machine-new")).resolves.toMatchObject({
      clerkUserId: "user_local",
      handle: "local",
      targetBundleSha256: "new-bundle",
    });
  });

  it("rolls back the prior-machine delete when replacement validation fails", async () => {
    await insertUserMachine(db, localMachine("machine-old"));
    await sql`
      CREATE FUNCTION reject_local_replacement() RETURNS trigger AS $$
      BEGIN
        IF NEW.machine_id = 'machine-new' THEN
          RAISE EXCEPTION 'forced replacement failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `.execute(db.executor);
    await sql`
      CREATE TRIGGER reject_local_replacement
      BEFORE INSERT ON user_machines
      FOR EACH ROW EXECUTE FUNCTION reject_local_replacement()
    `.execute(db.executor);

    await expect(seedLocalParityMachine(db, seedState())).rejects.toThrow(
      "forced replacement failure",
    );

    await expect(getUserMachine(db, "machine-old")).resolves.toMatchObject({
      clerkUserId: "user_local",
      handle: "local",
    });
    await expect(getUserMachine(db, "machine-new")).resolves.toBeUndefined();
  });

  it("refuses to delete a previous machine that does not match local ownership markers", async () => {
    await insertUserMachine(db, localMachine("machine-old", {
      clerkUserId: "user_foreign",
      imageVersion: "production",
      targetBundleVersion: "production",
      hetznerServerId: 777,
    }));

    await expect(seedLocalParityMachine(db, seedState())).rejects.toThrow(
      "Refusing to replace machine machine-old",
    );
    await expect(getUserMachine(db, "machine-old")).resolves.toBeDefined();
    await expect(getUserMachine(db, "machine-new")).resolves.toBeUndefined();
  });

  it("is idempotent when the database commit succeeded before state was checkpointed", async () => {
    await insertUserMachine(db, localMachine("machine-old"));
    const state = seedState();
    await seedLocalParityMachine(db, state);

    await expect(seedLocalParityMachine(db, state)).resolves.toBeUndefined();
    await expect(getUserMachine(db, "machine-old")).resolves.toBeUndefined();
    await expect(getUserMachine(db, "machine-new")).resolves.toMatchObject({
      clerkUserId: "user_local",
      targetBundleSha256: "new-bundle",
    });
  });

  it("reconciles a committed candidate when the parent checkpoint was lost", async () => {
    await insertUserMachine(db, localMachine("machine-b"));
    const retryState = seedState({
      machineId: "machine-b",
      previousMachineId: "machine-a",
      seededMachineId: "machine-a",
    });

    await seedLocalParityMachine(db, retryState);

    await expect(getUserMachine(db, "machine-a")).resolves.toBeUndefined();
    await expect(getUserMachine(db, "machine-b")).resolves.toMatchObject({
      clerkUserId: "user_local",
      handle: "local",
    });
  });

  it("retries an explicitly unseeded first launch after its candidate fails", async () => {
    await seedLocalParityMachine(db, seedState({
      machineId: "machine-b",
      previousMachineId: undefined,
      seededMachineId: null,
    }));

    await expect(getUserMachine(db, "machine-b")).resolves.toMatchObject({
      clerkUserId: "user_local",
      handle: "local",
    });
  });
});
