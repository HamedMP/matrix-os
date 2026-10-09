import { SiteSubmissionCursorSchema } from '@matrix-os/contracts';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
export interface SubmissionInput {siteId:string;appSlug:string;versionId:string;formId:string;idempotencyKey:string;fields:Record<string,unknown>}
export interface SiteSubmission {id:string;siteId:string;formId:string;fields:Record<string,unknown>;createdAt:string}
/** Wrapper never destroys the dependency-injected owner database. */
export class SiteSubmissionRepository {
 constructor(private readonly db:Kysely<any>){}
 async bootstrap():Promise<void>{await this.db.transaction().execute(async trx=>{await sql`CREATE TABLE IF NOT EXISTS public._site_submissions (
 id uuid PRIMARY KEY,site_id uuid NOT NULL,app_slug text NOT NULL,version_id uuid NOT NULL,form_id text NOT NULL,idempotency_key text NOT NULL,fields jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz,
 UNIQUE(site_id,form_id,idempotency_key))`.execute(trx);await sql`CREATE INDEX IF NOT EXISTS site_submissions_owner_read ON public._site_submissions(site_id,app_slug,created_at,id) WHERE deleted_at IS NULL`.execute(trx);});}
 async submit(input:SubmissionInput):Promise<void>{await this.db.transaction().execute(async trx=>{
  await sql`SET LOCAL lock_timeout = '2s'`.execute(trx);
  await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
  // Serialises quota admission for this site without an unbounded application mutex.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.siteId},0))`.execute(trx);
  const existing=await trx.selectFrom('_site_submissions').select('id').where('site_id','=',input.siteId).where('form_id','=',input.formId).where('idempotency_key','=',input.idempotencyKey).executeTakeFirst();if(existing)return;
  const count=await trx.selectFrom('_site_submissions').select(sql<number>`count(*)::int`.as('count')).where('site_id','=',input.siteId).executeTakeFirstOrThrow();if(count.count>=100000)throw new Error('Site submission quota reached');
  await trx.insertInto('_site_submissions').values({id:randomUUID(),site_id:input.siteId,app_slug:input.appSlug,version_id:input.versionId,form_id:input.formId,idempotency_key:input.idempotencyKey,fields:JSON.stringify(input.fields)}).onConflict(oc=>oc.columns(['site_id','form_id','idempotency_key']).doNothing()).execute();
 });}
 async list(siteId:string,appSlug:string,limit:number,cursor:string|null=null):Promise<{items:SiteSubmission[];nextCursor:string|null}>{
  let query=this.db.selectFrom('_site_submissions').select(['id','site_id','form_id','fields',
   sql<string>`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('created_at_exact'),
  ]).where('site_id','=',siteId).where('app_slug','=',appSlug).where('deleted_at','is',null);
  if(cursor!==null){
   const [createdAt,id]=SiteSubmissionCursorSchema.parse(cursor).split('|');
   query=query.where(sql<boolean>`(created_at, id) < (${createdAt}::timestamptz, ${id}::uuid)`);
  }
  const rows=await query.orderBy('created_at','desc').orderBy('id','desc').limit(limit+1).execute();
  const page=rows.slice(0,limit),last=page.at(-1);
  return {items:page.map(row=>({id:row.id,siteId:row.site_id,formId:row.form_id,fields:row.fields,createdAt:row.created_at_exact})),
   nextCursor:rows.length>limit&&last?`${last.created_at_exact}|${last.id}`:null};
 }
 async delete(siteId:string,appSlug:string,id:string):Promise<boolean>{
  const result=await this.db.updateTable('_site_submissions').set({fields:JSON.stringify({}),deleted_at:new Date()}).where('site_id','=',siteId).where('app_slug','=',appSlug).where('id','=',id).where('deleted_at','is',null).returning('id').executeTakeFirst();return Boolean(result);
 }
}
