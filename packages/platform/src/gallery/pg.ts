import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { GalleryDatabase } from './types.js';

let _galleryDb: Kysely<GalleryDatabase> | undefined;

export function createGalleryDb(connectionString?: string): Kysely<GalleryDatabase> {
  const connStr = connectionString ?? process.env.POSTGRES_URL;
  if (!connStr) {
    throw new Error('POSTGRES_URL is required for gallery database');
  }

  const pool = new pg.Pool({ connectionString: connStr });
  return new Kysely<GalleryDatabase>({
    dialect: new PostgresDialect({ pool }),
  });
}

export function getGalleryDb(connectionString?: string): Kysely<GalleryDatabase> {
  if (!_galleryDb) {
    _galleryDb = createGalleryDb(connectionString);
  }
  return _galleryDb;
}

export async function destroyGalleryDb(): Promise<void> {
  if (_galleryDb) {
    await _galleryDb.destroy();
    _galleryDb = undefined;
  }
}
