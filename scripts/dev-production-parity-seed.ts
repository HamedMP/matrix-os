import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { statePath } from "./local-production-parity/config.mjs";
import {
  createPlatformDb,
  getUserMachine,
  insertUserMachine,
  lockUserMachineProvisioning,
  updateUserMachine,
  type PlatformDB,
  type UserMachineRecord,
} from "../packages/platform/src/db.js";
import { hashRegistrationToken } from "../packages/platform/src/customer-vps-auth.js";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export interface LocalParitySeedState {
  machineId: string;
  previousMachineId?: string;
  seededMachineId?: string | null;
  clerkUserId: string;
  handle: string;
  hetznerServerId: number;
  registrationToken: string;
  registrationTokenExpiresAt: string;
  bundleSha256: string;
}

function assertDisposableLocalMachine(
  machine: UserMachineRecord | undefined,
  state: LocalParitySeedState,
  machineId: string,
): asserts machine is UserMachineRecord {
  if (
    !machine
    || machine.machineId !== machineId
    || machine.clerkUserId !== state.clerkUserId
    || machine.handle !== state.handle
    || machine.runtimeSlot !== "primary"
    || machine.provisioningClass !== "customer"
    || machine.hetznerServerId !== state.hetznerServerId
    || machine.imageVersion !== "local-working-tree"
    || machine.targetBundleVersion !== "local-working-tree"
  ) {
    throw new Error(`Refusing to replace machine ${machineId}; it is not this local parity environment`);
  }
}

export async function seedLocalParityMachine(db: PlatformDB, state: LocalParitySeedState): Promise<void> {
  const values = {
    clerkUserId: state.clerkUserId,
    handle: state.handle,
    runtimeSlot: "primary",
    provisioningClass: "customer" as const,
    accessClerkUserIds: [],
    developerTools: ["codex", "pi"] as Array<"codex" | "pi">,
    hetznerServerId: state.hetznerServerId,
    status: "provisioning",
    imageVersion: "local-working-tree",
    targetBundleVersion: "local-working-tree",
    targetBundleSha256: state.bundleSha256,
    registrationTokenHash: hashRegistrationToken(state.registrationToken),
    registrationTokenExpiresAt: state.registrationTokenExpiresAt,
    provisionedAt: new Date().toISOString(),
    activationState: "authorized" as const,
  };

  await db.transaction(async (transaction) => {
    await lockUserMachineProvisioning(transaction, state.clerkUserId);
    const current = await getUserMachine(transaction, state.machineId);
    if (current) {
      assertDisposableLocalMachine(current, state, state.machineId);
      await updateUserMachine(transaction, state.machineId, values);
      return;
    }

    if (state.previousMachineId && state.previousMachineId !== state.machineId) {
      const previous = await getUserMachine(transaction, state.previousMachineId);
      assertDisposableLocalMachine(previous, state, state.previousMachineId);
      const deleted = await transaction.executor.deleteFrom("user_machines")
        .where("machine_id", "=", state.previousMachineId)
        .returning("machine_id")
        .executeTakeFirst();
      if (deleted?.machine_id !== state.previousMachineId) {
        throw new Error(`Failed to replace local parity machine ${state.previousMachineId}`);
      }
    }
    await insertUserMachine(transaction, { machineId: state.machineId, ...values });
  });
}

async function main(): Promise<void> {
  const state = JSON.parse(
    await readFile(statePath, "utf8"),
  ) as LocalParitySeedState;
  const db = createPlatformDb(required("PLATFORM_DATABASE_URL"));
  try {
    await db.ready;
    await seedLocalParityMachine(db, state);
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
