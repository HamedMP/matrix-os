import { sql, type Transaction } from 'kysely';
import type { OwnerBotDatabase } from './database.js';
export async function migrateChatGptPlanDevices(tx: Transaction<OwnerBotDatabase>) {
    await sql `CREATE TABLE bot_chatgpt_plan_devices (
    owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 160), computer_id TEXT NOT NULL CHECK (length(computer_id) BETWEEN 1 AND 160),
    device_id TEXT NOT NULL CHECK (device_id ~ '^[a-f0-9]{64}$'), public_key TEXT NOT NULL CHECK (length(public_key) BETWEEN 32 AND 1024),
    PRIMARY KEY (owner_id, computer_id)
  )`.execute(tx);
}
