import { readFile } from "node:fs/promises";
import { createPlatformDb, getUserMachine, insertUserMachine, updateUserMachine } from "../packages/platform/src/db.js";
import { hashRegistrationToken } from "../packages/platform/src/customer-vps-auth.js";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const state = JSON.parse(
  await readFile(".amp/in/local-production-parity/state.json", "utf8"),
) as {
  machineId: string;
  clerkUserId: string;
  handle: string;
  hetznerServerId: number;
  registrationToken: string;
  registrationTokenExpiresAt: string;
  bundleSha256: string;
};

const db = createPlatformDb(required("PLATFORM_DATABASE_URL"));
try {
  await db.ready;
  await db.executor.deleteFrom("user_machines")
    .where("handle", "=", state.handle)
    .where("machine_id", "!=", state.machineId)
    .execute();
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
  if (await getUserMachine(db, state.machineId)) {
    await updateUserMachine(db, state.machineId, values);
  } else {
    await insertUserMachine(db, { machineId: state.machineId, ...values });
  }
} finally {
  await db.destroy();
}
