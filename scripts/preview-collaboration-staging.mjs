// Staging-database side of spec 535 A0b: registers a disposable pr-<N> home with the
// preview platform under its real machine ID and collaboration owner, and waits for
// the home to enroll its runtime endpoint there. The preview platform authenticates a
// home by `vps:<MATRIX_MACHINE_ID>` against this row, so the synthetic share fixture
// row (machine `chat-share-preview-pr-<N>`) cannot stand in for it.
import { pathToFileURL } from "node:url";

const HANDLE = /^pr-[1-9][0-9]{0,8}$/;
const MACHINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWNER = /^user_[A-Za-z0-9]{1,64}$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;

export class CollaborationPreviewError extends Error {
  constructor(code) {
    super(`Collaboration preview ${code}`);
    this.name = "CollaborationPreviewError";
    this.code = code;
  }
}

export function parseCollaborationHome(input) {
  const { handle, machineId, ownerId, address } = input ?? {};
  if (typeof handle !== "string" || !HANDLE.test(handle)
    || typeof machineId !== "string" || !MACHINE_ID.test(machineId)
    || typeof ownerId !== "string" || !OWNER.test(ownerId)
    || typeof address !== "string" || !IPV4.test(address)) {
    throw new CollaborationPreviewError("invalid_input");
  }
  return { handle, machineId, ownerId, address };
}

/**
 * One transaction: retire this handle's synthetic share fixture row and any earlier
 * incarnation owned by the same collaboration owner (both hold the active
 * (handle, runtime_slot) slot), then upsert the real machine with an empty access
 * list. A row for this machine owned by anyone else, or a slot held by any other
 * account, is refused, never reassigned.
 */
export async function registerCollaborationHome(client, input, now = new Date()) {
  const home = parseCollaborationHome(input);
  const timestamp = now.toISOString();
  await client.query("BEGIN");
  try {
    await client.query(`UPDATE user_machines
      SET status = 'deleted', deleted_at = $4
      WHERE handle = $1 AND runtime_slot = $1 AND provisioning_class = 'preview'
        AND deleted_at IS NULL AND machine_id <> $2
        AND clerk_user_id IN ('chat-share-preview-fixture', $3, $5)`,
    [home.handle, home.machineId, `chat-share-preview-fixture-${home.handle}`, timestamp, home.ownerId]);
    const result = await client.query(`INSERT INTO user_machines
      (machine_id, clerk_user_id, handle, runtime_slot, provisioning_class, public_ipv4,
       status, provisioned_at, developer_tools, access_clerk_user_ids)
      VALUES ($1, $2, $3, $3, 'preview', $4, 'running', $5, '[]', '{}')
      ON CONFLICT (machine_id) DO UPDATE SET
        public_ipv4 = EXCLUDED.public_ipv4,
        status = 'running',
        deleted_at = NULL,
        provisioned_at = EXCLUDED.provisioned_at,
        access_clerk_user_ids = '{}'
      WHERE user_machines.clerk_user_id = EXCLUDED.clerk_user_id
        AND user_machines.handle = EXCLUDED.handle
        AND user_machines.runtime_slot = EXCLUDED.runtime_slot
        AND user_machines.provisioning_class = 'preview'
      RETURNING machine_id`,
    [home.machineId, home.ownerId, home.handle, home.address, timestamp]);
    if (result.rowCount !== 1) throw new CollaborationPreviewError("ownership_mismatch");
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Collaboration preview registration rollback failed:", rollbackError instanceof Error ? rollbackError.name : "UnknownError");
    }
    throw error;
  }
}

/** True once the home registered and attached its control stream after `since`. */
export async function readCollaborationEnrollment(client, input, since) {
  const home = parseCollaborationHome(input);
  const result = await client.query(`SELECT
      owner_id = $2 AND relay_handle = $3 AND last_seen_at >= $4::timestamptz
      AND last_control_at IS NOT NULL AND last_control_at >= $4::timestamptz AS enrolled
    FROM collaboration_runtime_endpoints WHERE runtime_id = $1`,
  [`vps:${home.machineId}`, home.ownerId, home.handle, since.toISOString()]);
  return result.rows[0]?.enrolled === true;
}

export async function waitForCollaborationEnrollment(client, input, options) {
  const { since, deadline, intervalMs = 5_000, now = () => Date.now(), sleep } = options;
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    if (await readCollaborationEnrollment(client, input, since)) return true;
    if (now() + intervalMs > deadline) return false;
    await wait(intervalMs);
  }
}

async function main() {
  const [command] = process.argv.slice(2);
  const input = {
    handle: process.env.PREVIEW_HANDLE,
    machineId: process.env.PREVIEW_MACHINE_ID,
    ownerId: process.env.PREVIEW_COLLABORATION_OWNER_USER_ID,
    address: process.env.PREVIEW_ADDRESS,
  };
  const { Client } = await import("pg");
  const client = new Client({
    connectionString: process.env.PREVIEW_DATABASE_URL,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  });
  try {
    await client.connect();
    if (command === "register") {
      await registerCollaborationHome(client, input);
    } else if (command === "enrollment") {
      const since = new Date(process.env.PREVIEW_ENROLLMENT_SINCE ?? "");
      const deadline = Date.parse(process.env.PREVIEW_ENROLLMENT_DEADLINE ?? "");
      if (Number.isNaN(since.getTime()) || Number.isNaN(deadline)) throw new CollaborationPreviewError("invalid_input");
      if (!await waitForCollaborationEnrollment(client, input, { since, deadline })) {
        throw new CollaborationPreviewError("not_enrolled");
      }
    } else {
      throw new CollaborationPreviewError("invalid_command");
    }
  } finally {
    try {
      await client.end();
    } catch (error) {
      console.error("Collaboration preview staging cleanup failed:", error instanceof Error ? error.name : "UnknownError");
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Codes only: never the database URL, a row, or an identity.
    console.error("Collaboration preview staging step failed:", error instanceof CollaborationPreviewError ? error.code : (error instanceof Error ? error.name : "UnknownError"));
    process.exitCode = 1;
  });
}
