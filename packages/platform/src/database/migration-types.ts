import type { Kysely, Transaction } from 'kysely';
import type { PlatformDatabase } from '../db.js';

export type PlatformMigrationExecutor = Kysely<PlatformDatabase> | Transaction<PlatformDatabase>;
