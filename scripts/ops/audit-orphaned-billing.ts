import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { auditBillingOwners, loadBillingAuditOwners } from '../../packages/platform/src/account-deletion/orphaned-billing-audit.js';

// No platform bootstrap: this command must never run startup migrations.
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--gcp-project' || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(args[1]))) {
    throw new Error('Expected --gcp-project <project-id> or environment credentials');
  }
  const project = args[1];
  function credential(variable: string, secret: string): string {
    const existing = process.env[variable]?.trim();
    if (existing) return existing;
    if (!project) throw new Error('Billing audit configuration unavailable');
    return execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', '--project', project, '--secret', secret],
      { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 }).trim();
  }
  const clerkSecretKey = credential('CLERK_SECRET_KEY', 'clerk-secret-key');
  const client = new pg.Client({ connectionString: credential('PLATFORM_DATABASE_URL', 'platform-database-url'),
    connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
  let owners: string[];
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    owners = await loadBillingAuditOwners((sql, values) => client.query<{ clerk_user_id: string }>(sql, values));
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
  const result = await auditBillingOwners(owners, { clerkSecretKey });
  // Public CI output includes aggregate evidence only, never customer IDs or credentials.
  console.log(JSON.stringify({ audit: 'billing-owner-identities', ...result }));
  if (result.missing || result.inconclusive) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('Billing owner audit failed; completeness could not be established.', error instanceof Error ? error.name : 'UnknownError');
  process.exitCode = 1;
});
