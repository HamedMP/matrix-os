import { pathToFileURL } from "node:url";
import { registerCollaborationHome, CollaborationPreviewError } from "./preview-collaboration-staging.mjs";

const OWNER = /^user_[A-Za-z0-9]{1,64}$/;
const APP_ID = /^A[A-Z0-9]{5,24}$/;

export async function assertSlackPreviewOwner(client, { appId, ownerId }) {
  if (typeof appId !== "string" || !APP_ID.test(appId) || typeof ownerId !== "string" || !OWNER.test(ownerId)) {
    throw new CollaborationPreviewError("invalid_input");
  }
  const result = await client.query(`SELECT count(DISTINCT i.team_id)::int AS installations,
      count(DISTINCT l.team_id)::int AS linked_teams
    FROM slack_installations i
    LEFT JOIN slack_employee_links l ON l.app_id = i.app_id AND l.team_id = i.team_id
    WHERE i.app_id = $1 AND i.state = 'active' AND l.actor_id = $2`, [appId, ownerId]);
  const row = result.rows[0];
  if (row?.installations !== 1 || row?.linked_teams !== 1) {
    throw new CollaborationPreviewError("slack_owner_mismatch");
  }
}

export async function registerSlackPreviewHome(client, input, appId) {
  await assertSlackPreviewOwner(client, { appId, ownerId: input.ownerId });
  await registerCollaborationHome(client, input);
}

async function main() {
  const command = process.argv[2];
  const input = {
    handle: process.env.PREVIEW_HANDLE,
    machineId: process.env.PREVIEW_MACHINE_ID,
    ownerId: process.env.PREVIEW_RUNTIME_OWNER_ID,
    address: process.env.PREVIEW_ADDRESS,
  };
  const appId = process.env.SLACK_PILOT_APP_ID;
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.SLACK_PREVIEW_DATABASE_URL,
    connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
  try {
    await client.connect();
    if (command === "register") await registerSlackPreviewHome(client, input, appId);
    else if (command !== "verify") throw new CollaborationPreviewError("invalid_command");
    else await assertSlackPreviewOwner(client, { appId, ownerId: input.ownerId });
  } finally {
    try { await client.end(); }
    catch (error) {
      console.error("Slack preview database cleanup failed:", error instanceof Error ? error.name : "UnknownError");
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("Slack preview runtime setup failed:", error instanceof CollaborationPreviewError ? error.code : (error instanceof Error ? error.name : "UnknownError"));
    process.exitCode = 1;
  });
}
