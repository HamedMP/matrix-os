import { sql } from 'kysely';
import { z } from 'zod/v4';
import type { PlatformDB } from '../db.js';

/** Remote sessions must be revoked before database access-token rows are erased. */
export async function revokeOwnerMatrixCredentials(db:PlatformDB,owner:string,homeserverUrl:string|undefined,request:typeof fetch=fetch) {
  const tokens=await sql<{human_access_token:string;ai_access_token:string}>`
    SELECT human_access_token,ai_access_token FROM matrix_users WHERE handle IN
      (SELECT handle FROM users WHERE clerk_id=${owner} UNION SELECT handle FROM user_machines WHERE clerk_user_id=${owner}
        UNION SELECT handle FROM containers WHERE clerk_user_id=${owner}) LIMIT 1001`.execute(db.executor);
  if(!tokens.rows.length)return;
  if(tokens.rows.length>1000)throw new Error('Matrix credential cleanup capacity exceeded');
  if(!homeserverUrl)throw new Error('Matrix credential cleanup configuration unavailable');
  const configured=new URL(homeserverUrl);
  if(!['https:','http:'].includes(configured.protocol)||configured.username||configured.password)throw new Error('Matrix credential cleanup configuration unavailable');
  for(const row of tokens.rows) {
    for(const token of [row.human_access_token,row.ai_access_token]) {
      z.string().min(1).max(16384).parse(token);
      const response=await request(new URL('/_matrix/client/v3/logout/all',configured).toString(),{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(10_000),headers:{Authorization:`Bearer ${token}`},
      });
      if(response.ok){await response.body?.cancel();continue;}
      if(response.status===401){
        const error=z.object({errcode:z.string().max(128)}).safeParse(await response.json());
        if(error.success&&error.data.errcode==='M_UNKNOWN_TOKEN')continue;
      }
      throw new Error('Matrix credential cleanup unavailable');
    }
  }
}
