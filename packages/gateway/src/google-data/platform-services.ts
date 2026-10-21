import type { Kysely } from 'kysely';
import { createGoogleDataAuthority, type GoogleDataAuthority } from './authority.js';
import { createGoogleDataRepository, type GoogleDataRepository } from './repository.js';

export interface GooglePlatformServices {
  repository: GoogleDataRepository;
  authority: GoogleDataAuthority;
  migrate(): Promise<void>;
  close(): Promise<void>;
}
/** The host owns the injected pool. No approved profiles or credentials are
 * seeded. Owner-facing consent is separate from runtime processing admission. */
export function createGooglePlatformServices<DB>(db: Kysely<DB>): GooglePlatformServices {
  const repository = createGoogleDataRepository(db);
  const authority = createGoogleDataAuthority(repository);
  return { repository, authority,
    async migrate() { await repository.migrate(); repository.startCleanup(); },
    close: () => repository.close(),
  };
}
