import { randomUUID } from 'node:crypto';
import { sql,type Kysely } from 'kysely';
import { GoogleDataAuthorityError } from '../profiles.js';
import { googleContextOriginId } from '../runtime/contexts.js';
import { GooglePurgeAckSchema,GooglePurgeCommandSchema,PurgeOwnerSchema,type GooglePurgeCommand } from './contracts.js';
export interface PurgeConsentRow { id:string; owner_id:string; google_account_id:string }
const deny=():never=>{throw new GoogleDataAuthorityError();};
/** Same global registry lock and transaction as the authority mutation. No content/credentials. */
export async function queueGooglePurgeConsents<DB>(tx:Kysely<DB>,rows:readonly PurgeConsentRow[]):Promise<void> {
  if (!tx.isTransaction || rows.length>1000) deny(); if (!rows.length) return;
  const unique=[...new Map(rows.map(row=>[row.id,row])).values()];
  for(const row of unique) {PurgeOwnerSchema.parse(row.owner_id);GooglePurgeCommandSchema.shape.consentId.parse(row.id);GooglePurgeCommandSchema.shape.googleAccountId.parse(row.google_account_id);}
  await sql`SELECT pg_advisory_xact_lock(5510356)`.execute(tx);
  const payload=JSON.stringify(unique);
  const over=(await sql`WITH incoming AS (SELECT * FROM jsonb_to_recordset(${payload}::jsonb) i(id UUID,owner_id TEXT,google_account_id UUID)),
    missing AS (SELECT i.* FROM incoming i WHERE NOT EXISTS(SELECT 1 FROM google_data_purge_commands c WHERE c.consent_id=i.id))
    SELECT 1 WHERE (SELECT count(*) FROM google_data_purge_commands)+(SELECT count(*) FROM missing)>100000
      OR EXISTS(SELECT 1 FROM missing m GROUP BY m.owner_id HAVING count(*)+
        (SELECT count(*) FROM google_data_purge_commands c WHERE c.owner_id=m.owner_id)>1000)`.execute(tx)).rows.length;
  if(over) deny();
  const records=unique.map(row=>({command_id:randomUUID(),...row,origin_id:googleContextOriginId(row.owner_id,row.google_account_id,row.id)}));
  await sql`INSERT INTO google_data_purge_commands(id,owner_id,google_account_id,consent_id,origin_id,revision,state,target_machine_id)
    SELECT i.command_id,i.owner_id,i.google_account_id,i.id,i.origin_id,1,'pending',
      (SELECT p.machine_id FROM google_data_purge_runtime_pins p WHERE p.owner_id=i.owner_id)
    FROM jsonb_to_recordset(${JSON.stringify(records)}::jsonb) i(command_id UUID,id UUID,owner_id TEXT,google_account_id UUID,origin_id TEXT)
    ON CONFLICT(consent_id) DO NOTHING`.execute(tx);
}
export async function migrateGooglePurgeDelivery<DB>(tx:Kysely<DB>) {
  if(!tx.isTransaction) deny();
  await sql`CREATE TABLE IF NOT EXISTS google_data_purge_runtime_pins(owner_id TEXT PRIMARY KEY,machine_id TEXT NOT NULL)`.execute(tx);
  await sql`CREATE TABLE IF NOT EXISTS google_data_purge_commands(id UUID PRIMARY KEY,owner_id TEXT NOT NULL,
    google_account_id UUID NOT NULL,consent_id UUID UNIQUE NOT NULL,origin_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0),state TEXT NOT NULL CHECK(state IN ('pending','acked')),
    target_machine_id TEXT,lease_token UUID,lease_machine_id TEXT,lease_until TIMESTAMPTZ,receipt JSONB,acked_at TIMESTAMPTZ,
    last_polled_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`.execute(tx);
  await sql`ALTER TABLE google_data_purge_commands ADD COLUMN IF NOT EXISTS target_machine_id TEXT`.execute(tx);
  await sql`ALTER TABLE google_data_purge_commands ADD COLUMN IF NOT EXISTS last_polled_at TIMESTAMPTZ`.execute(tx);
  await sql`CREATE INDEX IF NOT EXISTS google_data_purge_owner ON google_data_purge_commands(owner_id,state,created_at)`.execute(tx);
}
/** Pending commands have no TTL. ACK is an exact authenticated-host receipt, never all-copy coverage. */
export function createGooglePurgeDeliveryStore<DB>(db:Kysely<DB>) {
  const transaction=<T>(work:(tx:Kysely<DB>)=>Promise<T>)=>db.transaction().execute(async tx=>{
    await sql`SET LOCAL statement_timeout='5s'`.execute(tx);await sql`SET LOCAL lock_timeout='2s'`.execute(tx);return work(tx);
  });
  return {
    /** Privileged operator configuration only; no HTTP/model endpoint. Immutable until verified owner teardown. */
    async pinRuntime(ownerId:string,machineId:string):Promise<void>{
      PurgeOwnerSchema.parse(ownerId);PurgeOwnerSchema.parse(machineId);
      await transaction(async tx=>{
        await sql`SELECT pg_advisory_xact_lock(5510356)`.execute(tx);
        const result=await sql`INSERT INTO google_data_purge_runtime_pins(owner_id,machine_id)
          SELECT ${ownerId},${machineId} WHERE EXISTS(SELECT 1 FROM google_data_purge_runtime_pins WHERE owner_id=${ownerId})
            OR (SELECT count(*) FROM google_data_purge_runtime_pins)<10000
          ON CONFLICT(owner_id) DO UPDATE SET machine_id=EXCLUDED.machine_id
            WHERE google_data_purge_runtime_pins.machine_id=EXCLUDED.machine_id RETURNING owner_id`.execute(tx);
        if(!result.rows.length)deny();
      });
    },
    async admitRuntime(ownerId:string,machineId:string):Promise<boolean>{
      PurgeOwnerSchema.parse(ownerId);PurgeOwnerSchema.parse(machineId);
      return transaction(async tx=>(await sql`SELECT owner_id FROM google_data_purge_runtime_pins
        WHERE owner_id=${ownerId} AND machine_id=${machineId}`.execute(tx)).rows.length===1);
    },
    async poll(ownerId:string,machineId:string):Promise<GooglePurgeCommand[]> {
      PurgeOwnerSchema.parse(ownerId);PurgeOwnerSchema.parse(machineId);
      return transaction(async tx=>{
        const rows=(await sql<{id:string;owner_id:string;google_account_id:string;consent_id:string;origin_id:string;revision:number;lease_token:string|null;lease_machine_id:string|null;lease_until:Date|null}>`
          SELECT * FROM google_data_purge_commands WHERE owner_id=${ownerId} AND target_machine_id=${machineId} AND state='pending'
            AND (lease_until IS NULL OR lease_until<=clock_timestamp() OR lease_machine_id=${machineId})
          ORDER BY last_polled_at ASC NULLS FIRST,created_at,id LIMIT 20 FOR UPDATE SKIP LOCKED`.execute(tx)).rows;
        const commands:GooglePurgeCommand[]=[]; // At most20, request-local.
        for(const row of rows) {
          const lease=(await sql<{lease_token:string;lease_until:Date}>`UPDATE google_data_purge_commands SET
            lease_token=CASE WHEN lease_machine_id=${machineId} AND lease_until>clock_timestamp() THEN lease_token ELSE ${randomUUID()}::uuid END,
            last_polled_at=clock_timestamp(),lease_machine_id=${machineId},lease_until=CASE WHEN lease_machine_id=${machineId} AND lease_until>clock_timestamp() THEN lease_until ELSE clock_timestamp()+interval '60 seconds' END
            WHERE id=${row.id} RETURNING lease_token,lease_until`.execute(tx)).rows[0]!;
          commands.push(GooglePurgeCommandSchema.parse({commandId:row.id,ownerId:row.owner_id,googleAccountId:row.google_account_id,
            consentId:row.consent_id,originId:row.origin_id,revision:row.revision,leaseToken:lease.lease_token,leaseUntil:lease.lease_until.toISOString()}));
        } return commands;
      });
    },
    async ack(ownerId:string,machineId:string,value:unknown):Promise<void> {
      PurgeOwnerSchema.parse(ownerId);PurgeOwnerSchema.parse(machineId);const input=GooglePurgeAckSchema.parse(value);
      await transaction(async tx=>{
        const changed=await sql`UPDATE google_data_purge_commands SET state='acked',receipt=${JSON.stringify(input.receipt)}::jsonb,
          acked_at=COALESCE(acked_at,clock_timestamp()) WHERE id=${input.commandId} AND owner_id=${ownerId} AND revision=${input.revision}
          AND target_machine_id=${machineId} AND lease_token=${input.leaseToken} AND lease_machine_id=${machineId}
          AND ((state='pending' AND lease_until>clock_timestamp()) OR (state='acked' AND receipt=${JSON.stringify(input.receipt)}::jsonb)) RETURNING id`.execute(tx);
        if(!changed.rows.length) deny();
      });
    },
  };
}
