import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('platform DB migration workflow', () => {
  it('requires explicit confirmation before restoring into managed Postgres', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-db-migration.yml'), 'utf8');

    expect(workflow).toContain('default: verify');
    expect(workflow).toContain('MIGRATE PLATFORM DB TO MANAGED POSTGRES');
    expect(workflow).toContain('Refusing destructive migration without the exact confirmation phrase.');
    expect(workflow).toContain("if: ${{ inputs.mode == 'migrate' }}");
    expect(workflow).toContain("safe_identifier_re='^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$'");
    expect(workflow).toContain('Invalid %s: only letters, numbers, underscore, and hyphen are allowed.');
  });

  it('moves data through a VPS-local snapshot without uploading database dumps as artifacts', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-db-migration.yml'), 'utf8');

    expect(workflow).toContain('docker exec \'$SOURCE_CONTAINER\' pg_dump --format=custom --no-owner --no-acl');
    expect(workflow).toContain('/home/deploy/backups/platform-migration/platform-${GITHUB_RUN_ID}.dump');
    expect(workflow).toContain('cat \'$REMOTE_BACKUP\'');
    expect(workflow).toContain('pg_restore --list platform-source.dump');
    expect(workflow).toContain("pg_restore --list platform-source.dump | grep -q 'TABLE public users '");
    expect(workflow).toContain("pg_restore --list platform-source.dump | grep -q 'TABLE public user_machines '");
    expect(workflow).toContain("pg_restore --list platform-source.dump | grep -q 'TABLE public host_bundle_releases '");
    expect(workflow).toContain("pg_restore --list platform-source.dump | grep -q 'TABLE DATA public user_machines '");
    expect(workflow).toContain("pg_restore --list platform-source.dump | grep -q 'TABLE DATA public host_bundle_releases '");
    expect(workflow).toContain("find /home/deploy/backups/platform-migration -maxdepth 1 -type f -name 'platform-*.dump' -mtime +7 -delete");
    expect(workflow).not.toContain('actions/upload-artifact');
  });

  it('reads the managed target from GCP Secret Manager and masks the URL', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-db-migration.yml'), 'utf8');

    expect(workflow).toContain('google-github-actions/auth@v3');
    expect(workflow).toContain('gcloud secrets versions access latest');
    expect(workflow).toContain('--secret "$TARGET_SECRET"');
    expect(workflow).toContain('echo "::add-mask::$target_url"');
    expect(workflow).toContain('TARGET_DATABASE_URL=$target_url');
    expect(workflow).toContain('psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -At -c "SELECT 1" > /dev/null');
  });

  it('verifies key platform row counts after restore', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-db-migration.yml'), 'utf8');

    expect(workflow).toContain("select 'users=' || count(*) from public.users");
    expect(workflow).toContain("select 'user_machines=' || count(*) from public.user_machines");
    expect(workflow).toContain("select 'host_bundle_releases=' || count(*) from public.host_bundle_releases");
    expect(workflow).toContain("to_regclass('public.users')");
    expect(workflow).toContain('expected machine and release rows after restore');
  });

  it('fails loudly if pg_restore hits target-side SQL errors', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-db-migration.yml'), 'utf8');

    expect(workflow).toContain('pg_restore \\');
    expect(workflow).toContain('--exit-on-error \\');
    expect(workflow).toContain('--verbose \\');
    expect(workflow).toContain('Managed database tables after restore:');
  });
});
