// Frozen deployed #2198 30bba5fd3dbb831bfa733f27347e863bce20624f SQL.
// Keep independent of production migrations so removing v6 reproduces startup refusal.
import { sql, type Transaction } from "kysely";
import type { OwnerBotDatabase } from "../../../../packages/gateway/src/bots/database.js";
export const DEPLOYED_DEVICE_PINS_V6_SQL = `CREATE TABLE bot_chatgpt_plan_devices (
    owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 160), computer_id TEXT NOT NULL CHECK (length(computer_id) BETWEEN 1 AND 160),
    device_id TEXT NOT NULL CHECK (device_id ~ '^[a-f0-9]{64}$'), public_key TEXT NOT NULL CHECK (length(public_key) BETWEEN 32 AND 1024),
    PRIMARY KEY (owner_id, computer_id)
  )`;
export async function migrateDeployedChatGptPlanDevicesV6(trx: Transaction<OwnerBotDatabase>): Promise<void> {
  await sql.raw(DEPLOYED_DEVICE_PINS_V6_SQL).execute(trx);
}
