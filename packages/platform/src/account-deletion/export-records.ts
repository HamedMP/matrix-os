import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod/v4';
import type { PlatformDB } from '../db.js';
import { decodeExportCursor, encodeExportCursor } from './export-cursor.js';

const ROWS_PER_GROUP = 100;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const GROUPS = ['profile','posts','comments','likes','follows','machines','billing','onboarding',
  'apps','appRatings','appInstalls','creditLedger','onboardingJourney'] as const;
type Group = typeof GROUPS[number];
const Position = z.object({ after: z.string().max(512).nullable(), done: z.boolean() }).strict();
const Cursor = z.object({ version:z.literal(2), exportedAt:z.iso.datetime(),
  positions:z.record(z.enum(GROUPS),Position) }).strict();
type PortableRow = Record<string, unknown>;
export type AccountRecordPage = Record<Group, PortableRow[]> & {
  version:2; exportedAt:string; nextCursor:string|null; complete:boolean;
};
interface Selection { table:string; columns:readonly string[]; key:RawBuilder<unknown>; filter:RawBuilder<unknown>; time?:string }

/** Explicit portable columns only. Never project whole rows from credential-bearing tables. */
function selections(owner:string, ids:string[]): Record<Group,Selection> {
  const mine = (column:string) => sql`${sql.ref(column)} IN (${sql.join(ids)})`;
  const exact = (column:string) => sql`${sql.ref(column)} = ${owner}`;
  const key = (column:string) => sql`${sql.ref(column)}::text`;
  const pair = (a:string,b:string) => sql`jsonb_build_array(${sql.ref(a)},${sql.ref(b)})::text`;
  return {
    profile:{table:'users',columns:['id','clerk_id','handle','display_name','email','plan','status','created_at','updated_at'],key:key('id'),filter:exact('clerk_id'),time:'created_at'},
    posts:{table:'social_posts',columns:['id','author_id','content','type','media_urls','app_ref','likes_count','comments_count','created_at'],key:key('id'),filter:mine('author_id'),time:'created_at'},
    comments:{table:'social_comments',columns:['id','post_id','author_id','content','created_at'],key:key('id'),filter:mine('author_id'),time:'created_at'},
    likes:{table:'social_likes',columns:['post_id','user_id','created_at'],key:pair('user_id','post_id'),filter:mine('user_id'),time:'created_at'},
    follows:{table:'social_follows',columns:['follower_id','following_id','following_type','created_at'],key:pair('follower_id','following_id'),filter:mine('follower_id'),time:'created_at'},
    machines:{table:'user_machines',columns:['machine_id','handle','runtime_slot','status','provisioned_at','deleted_at'],key:key('machine_id'),filter:exact('clerk_user_id'),time:'provisioned_at'},
    billing:{table:'billing_subscriptions',columns:['runtime_slot','plan_slug','status','billing_interval','current_period_end'],key:key('stripe_subscription_id'),filter:exact('clerk_user_id')},
    onboarding:{table:'onboarding_first_run',columns:['completed_at','goal','steps','source'],key:key('clerk_user_id'),filter:exact('clerk_user_id'),time:'completed_at'},
    apps:{table:'apps_registry',columns:['id','name','slug','author_id','description','category','tags','version','source_url','manifest','screenshots','is_public','created_at','updated_at'],key:key('id'),filter:mine('author_id'),time:'created_at'},
    appRatings:{table:'app_ratings',columns:['app_id','user_id','rating','review','created_at'],key:pair('user_id','app_id'),filter:mine('user_id'),time:'created_at'},
    appInstalls:{table:'app_installs',columns:['app_id','user_id','installed_at'],key:pair('user_id','app_id'),filter:mine('user_id'),time:'installed_at'},
    creditLedger:{table:'ai_funded_credit_ledger',columns:['entry_id','runtime_slot','kind','amount_microusd','period_start','expires_at','created_at'],key:key('entry_id'),filter:exact('owner_id'),time:'created_at'},
    onboardingJourney:{table:'onboarding_journey_events',columns:['id','from_phase','to_phase','at'],key:key('id'),filter:exact('clerk_user_id'),time:'at'},
  };
}

/** Bounded live keyset export, not an MVCC snapshot spanning requests. */
export async function exportOwnerPlatformData(db:PlatformDB,owner:string,
  options:{cursor?:string;secret?:string} = {}):Promise<AccountRecordPage> {
  z.string().regex(/^user_[A-Za-z0-9_-]{1,150}$/).parse(owner);
  const state = options.cursor ? decodeExportCursor(options.cursor,owner,'records',Cursor,options.secret) : {
    version:2 as const,exportedAt:new Date().toISOString(),positions:Object.fromEntries(GROUPS.map(group=>[group,{after:null,done:false}])) as Record<Group,z.infer<typeof Position>> };
  await db.ready;
  return db.transaction(async trx=>{
    // One Clerk identity maps to at most one platform user; do not buffer an owner inventory.
    const profile = await trx.executor.selectFrom('users').select('id').where('clerk_id','=',owner).limit(2).execute();
    if(profile.length>1)throw new Error('Export identity mismatch');
    const definitions=selections(owner,[owner,...profile.map(row=>row.id)]);
    const result=Object.fromEntries(GROUPS.map(group=>[group,[]])) as Record<Group,PortableRow[]>;
    const positions={...state.positions};
    let bytes=0;
    for(const group of GROUPS){
      const position=state.positions[group];
      if(position.done)continue;
      const definition=definitions[group];
      const date=definition.time ? sql`${sql.ref(definition.time)}::timestamptz <= ${state.exportedAt}::timestamptz` : sql`true`;
      const after=position.after===null?sql`true`:sql`${definition.key} COLLATE "C" > ${position.after}`;
      // The DB bounds each payload before it crosses the process boundary; oversize is a failure, never truncation.
      const response=await sql<{ export_key:string; data:PortableRow|null }>`SELECT export_key,
        CASE WHEN octet_length(portable::text) <= ${MAX_RECORD_BYTES} THEN portable ELSE NULL END AS data
        FROM (SELECT ${definition.key} COLLATE "C" AS export_key,
          jsonb_build_object(${sql.join(definition.columns.flatMap(column=>[sql`${column}::text`,sql`${sql.ref(column)}`]))}) AS portable
          FROM ${sql.table(definition.table)} WHERE ${definition.filter} AND ${date} AND ${after}
          ORDER BY ${definition.key} COLLATE "C" LIMIT ${ROWS_PER_GROUP+1}) page`.execute(trx.executor);
      let accepted=0;
      let last=position.after;
      for(const row of response.rows.slice(0,ROWS_PER_GROUP)){
        if(row.data===null)throw new Error('Export record capacity exceeded');
        const size=Buffer.byteLength(JSON.stringify(row.data),'utf8');
        if(bytes+size>MAX_PAGE_BYTES)break;
        result[group].push(row.data);bytes+=size;last=row.export_key;accepted++;
      }
      positions[group]={after:last,done:accepted===response.rows.length};
      if(accepted<Math.min(response.rows.length,ROWS_PER_GROUP))break;
    }
    const complete=GROUPS.every(group=>positions[group].done);
    if(!complete&&!options.secret)throw new Error('Export continuation configuration unavailable');
    return {version:2,exportedAt:state.exportedAt,...result,complete,
      nextCursor:complete?null:encodeExportCursor({...state,positions},owner,'records',options.secret)};
  });
}
