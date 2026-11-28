import { sql,type Kysely } from 'kysely';
import { z } from 'zod/v4';
import type { PlatformDatabase } from '../platform-db.js';
import { createGoogleDataRepository } from './repository.js';
import { GoogleDataAuthorityError } from './profiles.js';
/** Called within the actual grant/status mutation. Acquire registry before connection locks. */
export async function revokeGoogleConnectedAccount(tx:Kysely<PlatformDatabase>,connectionId:string):Promise<void>{
 if(!tx.isTransaction)throw new GoogleDataAuthorityError();z.uuid().parse(connectionId);
 await sql`SELECT pg_advisory_xact_lock(5510356)`.execute(tx);
 const row=await tx.selectFrom('connected_services as c').innerJoin('users as u','u.id','c.user_id')
  .select(['c.service','u.clerk_id']).where('c.id','=',connectionId).forUpdate('c').executeTakeFirst();
 if(row?.service==='gmail')await createGoogleDataRepository(tx).revokeAccount(row.clerk_id,connectionId);
}
