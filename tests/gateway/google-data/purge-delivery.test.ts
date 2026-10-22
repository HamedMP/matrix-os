import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createAuthorityFixture } from './fixture-db.js';
import { consentInput, profileInput } from './fixtures.js';
import { createGoogleDataRepository } from '../../../packages/gateway/src/google-data/repository.js';
import { createGooglePurgeDeliveryStore,queueGooglePurgeConsents } from '../../../packages/gateway/src/google-data/purge-delivery/store.js';
let db: Awaited<ReturnType<typeof createAuthorityFixture>>['db'];
let delivery: ReturnType<typeof createGooglePurgeDeliveryStore>;
const owner = 'owner-one'; const machine = 'machine-one';
const receipt = { coverage: 'registered-copies-only' as const, complete: true as const, pending: 0, unresolved: 0, requestIds: [] };
beforeEach(async () => { ({ db } = await createAuthorityFixture()); delivery = createGooglePurgeDeliveryStore(db.sql); await delivery.pinRuntime(owner,machine); });
async function consent() { const profile = await db.repository.reviewProfile(profileInput(), 0); return db.repository.recordConsent(consentInput(profile.id), 0); }
const key = (record: Awaited<ReturnType<typeof consent>>) => ({ ownerId: owner, googleAccountId: record.input.googleAccountId, profileId: record.input.profileId, purposeId: record.input.purposeId });
describe('durable consent purge delivery', () => {
  it('pins one operator-selected runtime and refuses retargeting or another host taking its commands',async()=>{
    expect(await delivery.admitRuntime(owner,machine)).toBe(true);expect(await delivery.admitRuntime(owner,'other-machine')).toBe(false);
    await delivery.pinRuntime(owner,machine);await expect(delivery.pinRuntime(owner,'other-machine')).rejects.toThrow();
    const record=await consent();await db.repository.revokeAccount(owner,record.input.googleAccountId);
    await delivery.poll(owner,machine);await sql`UPDATE google_data_purge_commands SET lease_until=clock_timestamp()-interval '1 second'`.execute(db.sql);
    expect(await delivery.poll(owner,'other-machine')).toEqual([]);
  });
  it('does not retrospectively bind unknown historical commands to a newly selected runtime',async()=>{
    await sql`DELETE FROM google_data_purge_runtime_pins`.execute(db.sql);
    const record=await consent();await db.repository.revokeAccount(owner,record.input.googleAccountId);
    await delivery.pinRuntime(owner,machine);expect(await delivery.poll(owner,machine)).toEqual([]);
  });
  it('queues exact revoked generations atomically and keeps pending commands after registry cleanup', async () => {
    const record = await consent(); await db.repository.revokeConsent(key(record), 1);
    const [command] = await delivery.poll(owner, machine); expect(command).toMatchObject({ ownerId: owner, consentId: record.id, revision:1 });
    expect(command.originId).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(command)).not.toContain('Example processor');
    await db.repository.cleanup(new Date('2026-12-10T00:00:00Z'));
    expect(await delivery.poll(owner, machine)).toEqual([command]);
  });
  it.each(['replace','profile','owner-delete','expiry'] as const)('queues generation before %s removes its processing authority', async action => {
    const record = await consent();
    if (action==='replace') await db.repository.recordConsent(consentInput(record.input.profileId), 1);
    if (action==='profile') await db.repository.reviewProfile({ ...profileInput(),id:record.input.profileId }, 1);
    if (action==='owner-delete') await db.repository.deleteOwner(owner);
    if (action==='expiry') await db.repository.cleanup(new Date('2026-12-10T00:00:00Z'));
    expect(await delivery.poll(owner,machine)).toMatchObject([{ consentId:record.id }]);
  });
  it('deduplicates invalid generations and leases only the authenticated owner and machine', async () => {
    const record=await consent(); await db.repository.revokeAccount(owner,record.input.googleAccountId);
    await db.repository.revokeAccount(owner,record.input.googleAccountId);
    const commands=await delivery.poll(owner,machine); expect(commands).toHaveLength(1);
    expect(await delivery.poll('other-owner',machine)).toEqual([]);
    expect(await delivery.poll(owner,'other-machine')).toEqual([]);
    expect(await delivery.poll(owner,machine)).toEqual(commands);
  });
  it('rotates bounded polling so unresolved old commands cannot starve later work',async()=>{
    const rows=Array.from({length:21},()=>({id:randomUUID(),owner_id:owner,google_account_id:randomUUID()}));
    await db.sql.transaction().execute(tx=>queueGooglePurgeConsents(tx,rows));
    const first=await delivery.poll(owner,machine);expect(first).toHaveLength(20);
    const later=rows.find(row=>!first.some(command=>command.consentId===row.id))!;
    expect(await delivery.poll(owner,machine)).toEqual(expect.arrayContaining([expect.objectContaining({consentId:later.id})]));
  });
  it('requires live exact leases and complete registered-copy receipts; ACK retry is exact and idempotent', async () => {
    const record=await consent(); await db.repository.revokeAccount(owner,record.input.googleAccountId);
    const [command]=await delivery.poll(owner,machine); const ack={ commandId:command.commandId,revision:command.revision,leaseToken:command.leaseToken,receipt };
    await expect(delivery.ack('other-owner',machine,ack)).rejects.toThrow();
    await expect(delivery.ack(owner,'other-machine',ack)).rejects.toThrow();
    await expect(delivery.ack(owner,machine,{...ack,receipt:{...receipt,complete:false}})).rejects.toThrow();
    await expect(delivery.ack(owner,machine,{...ack,receipt:{...receipt,unresolved:1}})).rejects.toThrow();
    await delivery.ack(owner,machine,ack); await delivery.ack(owner,machine,ack);
    expect(await delivery.poll(owner,machine)).toEqual([]);
    await expect(delivery.ack(owner,machine,{...ack,revision:2})).rejects.toThrow();
  });
  it('rejects stale leases and reacquires pending work without replaying an old ACK', async () => {
    const record=await consent(); await db.repository.revokeAccount(owner,record.input.googleAccountId);
    const [old]=await delivery.poll(owner,machine);
    await sql`UPDATE google_data_purge_commands SET lease_until=clock_timestamp()-interval '1 second'`.execute(db.sql);
    await expect(delivery.ack(owner,machine,{commandId:old.commandId,revision:old.revision,leaseToken:old.leaseToken,receipt})).rejects.toThrow();
    const [fresh]=await delivery.poll(owner,machine); expect(fresh.leaseToken).not.toBe(old.leaseToken);
    await delivery.ack(owner,machine,{commandId:fresh.commandId,revision:fresh.revision,leaseToken:fresh.leaseToken,receipt});
  });
  it('keeps profile-before-consent lock order during concurrent snapshot and cleanup',async()=>{
    const record=await consent();let entered!:()=>void;const profileRead=new Promise<void>(resolve=>{entered=resolve;});
    let resume!:()=>void;const resumed=new Promise<void>(resolve=>{resume=resolve;});let waiting!:()=>void;
    const cleanupWaiting=new Promise<void>(resolve=>{waiting=resolve;});let paused=false;
    const snapshotDb=db.sql.withPlugin({transformQuery:args=>args.node,async transformResult(args){
      if(!paused&&args.result.rows[0]?.id===record.input.profileId){paused=true;entered();await resumed;}return args.result;
    }});
    const cleanupDb=db.sql.withPlugin({transformQuery(args){const text=JSON.stringify(args.node);
      if(text.includes('google_data_profiles')&&(text.includes('FOR UPDATE')||text.includes('DELETE FROM google_data_profiles')))waiting();return args.node;
    },async transformResult(args){return args.result;}});
    const reading=createGoogleDataRepository(snapshotDb).snapshot(key(record)).then(value=>({value}),error=>({error}));
    await profileRead;
    const deleting=createGoogleDataRepository(cleanupDb).cleanup(new Date('2026-12-10T00:00:00Z')).then(value=>({value}),error=>({error}));
    try{await cleanupWaiting;await new Promise(resolve=>setTimeout(resolve,50));}finally{resume();}
    expect(await reading).toHaveProperty('value');expect(await deleting).toHaveProperty('value');
  });
  it('rolls revocation back if durable command persistence fails', async () => {
    const record=await consent(); await sql`ALTER TABLE google_data_purge_commands ADD CONSTRAINT synthetic_failure CHECK(false) NOT VALID`.execute(db.sql);
    await expect(db.repository.revokeAccount(owner,record.input.googleAccountId)).rejects.toThrow();
    expect((await db.repository.snapshot(key(record))).consent?.status).toBe('active');
    expect(await delivery.poll(owner,machine)).toEqual([]);
  });
});
