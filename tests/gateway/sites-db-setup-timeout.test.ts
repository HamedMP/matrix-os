import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppDb } from '../../packages/gateway/src/app-db.js';
import { SiteSubmissionRepository } from '../../packages/gateway/src/sites/submission-repository.js';
import { registerSiteRuntime } from '../../packages/gateway/src/sites/wiring.js';
import { Hono } from 'hono';
import { Kysely } from 'kysely';
import { KyselyPGlite } from 'kysely-pglite';
const mocks=vi.hoisted(()=>({options:[] as any[],end:vi.fn(async()=>{})}));
vi.mock('pg',()=>({default:{Pool:class {constructor(options:unknown){mocks.options.push(options);}on=vi.fn();end=mocks.end;}}}));
afterEach(()=>{vi.restoreAllMocks();mocks.options.length=0;});
describe('bounded optional site database bootstrap',()=>{
 it('bounds shared production pool acquisition without changing other app query deadlines',async()=>{const {db}=createAppDb('postgres://synthetic/test');expect(mocks.options[0]).toMatchObject({connectionTimeoutMillis:5000});expect(mocks.options[0].statement_timeout).toBeUndefined();expect(mocks.options[0].query_timeout).toBeUndefined();await db.destroy();});
 it('applies server lock/statement deadlines inside the DDL transaction',async()=>{const instance=await KyselyPGlite.create();const statements:string[]=[];const db=new Kysely({dialect:instance.dialect,log:event=>{if(event.level==='query')statements.push(event.query.sql);}});try{await new SiteSubmissionRepository(db).bootstrap();const table=statements.findIndex(sql=>sql.includes('CREATE TABLE'));expect(statements.slice(0,table).some(sql=>sql.includes("lock_timeout = '2s'"))).toBe(true);expect(statements.slice(0,table).some(sql=>sql.includes("statement_timeout = '5s'"))).toBe(true);}finally{await db.destroy();}});
 it('continues route registration after a cancelled DDL without closing shared resources',async()=>{const failure=new Error('private postgres error');const bootstrap=vi.spyOn(SiteSubmissionRepository.prototype,'bootstrap').mockRejectedValue(failure);const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});const db={destroy:vi.fn()} as any;const app=new Hono();await registerSiteRuntime(app,{homePath:'/unused',db,env:{MATRIX_USER_ID:'owner'}});expect(bootstrap).toHaveBeenCalledOnce();expect(db.destroy).not.toHaveBeenCalled();expect(warning).toHaveBeenCalledWith('[sites] Submission database unavailable','Error');expect((await app.request('/api/internal/sites/550e8400-e29b-41d4-a716-446655440000/submit',{method:'POST',body:'{}'})).status).toBe(401);});
});
