import { isIP } from "node:net";
import { createHash, createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";

export function selectSharePreviewMachine(fleet, pr) {
  if (!/^[1-9][0-9]{0,8}$/.test(pr)) throw new Error("Invalid PR number");
  const handle = `pr-${pr}`;
  const matches = fleet.machines.filter((machine) => machine.handle === handle && !machine.deletedAt);
  if (matches.length !== 1) throw new Error("Expected one active preview");
  const machine = matches[0];
  const ownerId = machine.clerkUserId;
  const machineId = machine.machineId;
  const address = machine.publicIPv4;
  if (machine.runtimeSlot !== handle || machine.provisioningClass !== "preview" || machine.status !== "running" || isIP(address ?? "") !== 4
    || typeof ownerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(ownerId)
    || typeof machineId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(machineId)) throw new Error("Not a running PR preview");
  const [first, second] = address.split(".").map(Number);
  if ([0, 10, 127].includes(first) || first >= 224 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) throw new Error("Invalid preview address");
  return { handle, address, ownerId, machineId, runtimeSlot: handle };
}

export function buildSpeechPreviewActivation(fixture, pr, speechOrigin, platformSecret) {
  const selected = selectSharePreviewMachine({ machines: [{
    handle: fixture.handle,
    runtimeSlot: fixture.runtimeSlot,
    publicIPv4: fixture.address,
    provisioningClass: "preview",
    status: "running",
    clerkUserId: fixture.ownerId,
    machineId: fixture.machineId,
  }] }, pr);
  let origin;
  try {
    origin = new URL(speechOrigin);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    console.error("Preview speech origin URL parsing failed");
    throw new Error("Invalid preview speech origin");
  }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/"
    || origin.search || origin.hash || !origin.hostname.startsWith(`pr-${pr}---`)
    || !origin.hostname.endsWith(".a.run.app")) throw new Error("Invalid preview speech origin");
  if (typeof platformSecret !== "string" || Buffer.byteLength(platformSecret) < 32) throw new Error("Invalid preview platform secret");
  const speechRuntimeToken = createHmac("sha256", platformSecret).update(JSON.stringify([
    "matrix-platform-speech-runtime", 1, selected.handle, selected.machineId, selected.runtimeSlot,
  ])).digest("hex");
  return { ...selected, speechOrigin: origin.origin, speechRuntimeToken };
}

function affectedRows(result) {
  return result.rowCount ?? result.affectedRows ?? result.rows?.length ?? 0;
}

export async function seedSpeechPreviewFixture(client, activation, now = new Date()) {
  const { handle, address, ownerId, machineId, runtimeSlot } = activation;
  try {
    await client.query("BEGIN");
    const at = now.toISOString();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    // Replace only the legacy synthetic bridge row created by the previous
    // workflow. Exact predicates prevent this cleanup from touching any real
    // staging runtime that happens to share a similar handle.
    await client.query(`DELETE FROM user_machines
      WHERE machine_id = $1 AND clerk_user_id = 'chat-share-preview-fixture'
        AND handle = $2 AND runtime_slot = $2 AND provisioning_class = 'preview'`,
    [`chat-share-preview-${handle}`, handle]);
    await client.query(`DELETE FROM user_machines
      WHERE handle = $1 AND runtime_slot = $1 AND clerk_user_id = $2
        AND provisioning_class = 'preview' AND machine_id <> $3
        AND hetzner_server_id IS NULL AND deleted_at IS NULL`,
    [handle, ownerId, machineId]);
    const result = await client.query(`INSERT INTO user_machines
      (machine_id, clerk_user_id, handle, runtime_slot, provisioning_class, public_ipv4, status, activation_state, provisioned_at, developer_tools)
      VALUES ($1, $2, $3, $4, 'preview', $5, 'running', 'authorized', $6, '[]')
      ON CONFLICT (machine_id) DO UPDATE SET public_ipv4 = EXCLUDED.public_ipv4, status = 'running', activation_state = 'authorized', deleted_at = NULL, provisioned_at = EXCLUDED.provisioned_at
      WHERE user_machines.clerk_user_id = EXCLUDED.clerk_user_id AND user_machines.handle = EXCLUDED.handle AND user_machines.runtime_slot = EXCLUDED.runtime_slot
      RETURNING machine_id`, [machineId, ownerId, handle, runtimeSlot, address, at]);
    if (affectedRows(result) !== 1) throw new Error("Preview fixture ownership mismatch");
    const policy = await client.query(`INSERT INTO ai_funded_runtime_policies
      (machine_id, owner_id, runtime_slot, enabled, allowed_model_ids, monthly_budget_microusd, expires_at, next_issue_at, revision, created_at, updated_at)
      VALUES ($1, $2, $3, FALSE, '[]', 1000000, NULL, '1970-01-01T00:00:00.000Z', 0, $4, $4)
      ON CONFLICT (machine_id) DO UPDATE SET monthly_budget_microusd = 1000000, updated_at = EXCLUDED.updated_at
      WHERE ai_funded_runtime_policies.owner_id = EXCLUDED.owner_id AND ai_funded_runtime_policies.runtime_slot = EXCLUDED.runtime_slot
      RETURNING machine_id`, [machineId, ownerId, runtimeSlot, at]);
    if (affectedRows(policy) !== 1) throw new Error("Preview speech policy ownership mismatch");
    const balance = await client.query(`INSERT INTO ai_funded_runtime_balances
      (machine_id, owner_id, runtime_slot, credit_balance_microusd, promotional_balance_microusd, addon_balance_microusd, reserved_microusd, funding_shortfall_microusd, month_period_start, month_spent_microusd, month_reserved_microusd, updated_at)
      VALUES ($1, $2, $3, 0, 0, 0, 0, 0, $4, 0, 0, $5)
      ON CONFLICT (machine_id) DO UPDATE SET updated_at = EXCLUDED.updated_at
      WHERE ai_funded_runtime_balances.owner_id = EXCLUDED.owner_id AND ai_funded_runtime_balances.runtime_slot = EXCLUDED.runtime_slot
      RETURNING machine_id`, [machineId, ownerId, runtimeSlot, monthStart, at]);
    if (affectedRows(balance) !== 1) throw new Error("Preview speech balance ownership mismatch");
    const machineGrantKey = createHash("sha256").update(machineId).digest("hex").slice(0, 16);
    const entryId = `speech-preview:${handle}:${machineGrantKey}`;
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await client.query(`WITH ledger AS (
      INSERT INTO ai_funded_credit_ledger
        (entry_id, owner_id, machine_id, runtime_slot, kind, amount_microusd, source_reference, reservation_id, period_start, expires_at, created_at)
      VALUES ($1, $2, $3, $4, 'promotional_grant', 1000000, $1, NULL, NULL, $5, $6)
      ON CONFLICT (entry_id) DO NOTHING RETURNING entry_id
    ), grant_balance AS (
      INSERT INTO ai_funded_promotional_grant_balances
        (grant_entry_id, owner_id, machine_id, runtime_slot, remaining_microusd, expires_at, created_at, updated_at, revision)
      SELECT entry_id, $2, $3, $4, 1000000, $5, $6, $6, 0 FROM ledger RETURNING grant_entry_id
    ) UPDATE ai_funded_runtime_balances SET
      credit_balance_microusd = credit_balance_microusd + 1000000,
      promotional_balance_microusd = promotional_balance_microusd + 1000000,
      updated_at = $6
      WHERE machine_id = $3 AND owner_id = $2 AND runtime_slot = $4
        AND EXISTS (SELECT 1 FROM grant_balance)`, [entryId, ownerId, machineId, runtimeSlot, expiresAt, at]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  if (process.argv.includes("--select")) {
    const response = await fetch(new URL("/vps/fleet", process.env.PLATFORM_PUBLIC_URL), {
      headers: { authorization: `Bearer ${process.env.PLATFORM_SECRET}` },
      signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (!response.ok) throw new Error("Preview registry lookup failed");
    const selected = selectSharePreviewMachine(await response.json(), process.env.PR_NUMBER);
    await writeFile("preview-share-route.json", JSON.stringify(selected), { mode: 0o600 });
    return;
  }
  const fixture = JSON.parse(await readFile("preview-share-route.json", "utf8"));
  const activation = buildSpeechPreviewActivation(
    fixture, process.env.PR_NUMBER, process.env.SPEECH_ORIGIN, process.env.PLATFORM_SECRET,
  );
  // Only the exact runtime identity and public route enter staging. No provider
  // server metadata, owner credentials, or production database access is copied.
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.PREVIEW_DATABASE_URL, connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
  await client.connect();
  try {
    await seedSpeechPreviewFixture(client, activation);
    await writeFile("preview-speech-activation.json", JSON.stringify(activation), { mode: 0o600 });
    console.log("Exact preview speech identity registered in staging.");
  } finally {
    await client.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
