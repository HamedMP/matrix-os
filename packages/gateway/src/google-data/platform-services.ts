import type { Kysely } from 'kysely';
import { createGoogleDataAuthority, type GoogleDataAuthority } from './authority.js';
import { createGoogleDataRepository, type GoogleDataRepository } from './repository.js';
import { createGoogleRequestLedger, type GoogleRequestLedger } from './runtime/request-ledger.js';

export interface GooglePlatformServices {
  repository: GoogleDataRepository;
  authority: GoogleDataAuthority;
  requestLedger: GoogleRequestLedger;
  migrate(): Promise<void>;
  close(): Promise<void>;
}
/** The host owns the injected pool. No approved profiles or credentials are
 * seeded. Owner-facing consent is separate from runtime processing admission. */
export function createGooglePlatformServices<DB>(db: Kysely<DB>): GooglePlatformServices {
  const repository = createGoogleDataRepository(db);
  const authority = createGoogleDataAuthority(repository);
  const requestLedger = createGoogleRequestLedger(db);
  return { repository, authority, requestLedger,
    async migrate() {
      await repository.migrate();
      await requestLedger.migrate();
      repository.startCleanup(); requestLedger.startCleanup();
    },
    async close() { await Promise.all([repository.close(), requestLedger.close()]); },
  };
}
