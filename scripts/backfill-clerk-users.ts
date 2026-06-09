#!/usr/bin/env tsx
import { backfillClerkUsersToPlatformDb } from '../packages/platform/src/clerk-users.js';
import { createPlatformDb } from '../packages/platform/src/db.js';

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const quiet = process.argv.includes('--quiet');
  if (!apply && !process.argv.includes('--dry-run')) {
    console.log('Running in dry-run mode. Pass --apply to write users to the platform DB.');
  }

  const db = createPlatformDb(readRequiredEnv('PLATFORM_DATABASE_URL'));
  try {
    const result = await backfillClerkUsersToPlatformDb(db, {
      clerkSecretKey: readRequiredEnv('CLERK_SECRET_KEY'),
      apply,
      logger: quiet
        ? { log: () => undefined, warn: () => undefined }
        : console,
    });
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...result }, null, 2));
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
