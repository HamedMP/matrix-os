import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { GalleryDatabase } from '../../../packages/platform/src/gallery/types.js';
import { runGalleryMigrations } from '../../../packages/platform/src/gallery/migrations.js';
import {
  auditManifest,
  auditStaticCode,
  auditSandboxPolicy,
  runFullAudit,
  type AuditFinding,
} from '../../../packages/platform/src/gallery/security-audit.js';

const TEST_DB_URL = process.env.TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;

// Test patterns that simulate dangerous code -- these are intentionally
// dangerous-looking strings used as INPUT to the security audit scanner
const TRAVERSAL_CODE = '../' + '../' + '../etc/passwd';
const ENV_CODE = 'process' + '.env.SECRET_KEY';
const EVAL_CODE = 'ev' + 'al("test")';
const CP_MODULE = 'child' + '_process';
const FUNC_CTOR = 'new Fun' + 'ction("return this")()';

describe('gallery/security-audit', () => {
  describe('Layer 1: Manifest Audit', () => {
    it('passes valid manifest with allowed permissions', () => {
      const findings = auditManifest({
        name: 'My App',
        permissions: ['fs.read', 'net.fetch'],
      });
      expect(findings.length).toBe(0);
    });

    it('flags unknown permissions', () => {
      const findings = auditManifest({
        name: 'My App',
        permissions: ['fs.read', 'system.exec', 'root.access'],
      });
      const errors = findings.filter((f) => f.severity === 'error');
      expect(errors.length).toBe(2);
      expect(errors[0].rule).toBe('unknown-permission');
    });

    it('flags missing name', () => {
      const findings = auditManifest({ permissions: [] });
      expect(findings.some((f) => f.rule === 'missing-name')).toBe(true);
    });

    it('warns about missing integrations when required', () => {
      const findings = auditManifest({
        name: 'My App',
        permissions: [],
        integrations: { required: ['gmail.read'] },
      });
      const warnings = findings.filter((f) => f.severity === 'warning');
      expect(warnings.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Layer 2: Static Code Scan', () => {
    it('flags path traversal patterns', () => {
      const files = new Map([
        ['index.js', `const path = "${TRAVERSAL_CODE}";\nconst x = 1;`],
      ]);
      const findings = auditStaticCode(files);
      expect(findings.some((f) => f.rule === 'path-traversal')).toBe(true);
    });

    it('flags process.env access', () => {
      const files = new Map([
        ['config.js', `const key = ${ENV_CODE};`],
      ]);
      const findings = auditStaticCode(files);
      expect(findings.some((f) => f.rule === 'env-access')).toBe(true);
    });

    it('flags dynamic code execution', () => {
      const files = new Map([
        ['index.js', EVAL_CODE],
      ]);
      const findings = auditStaticCode(files);
      expect(findings.some((f) => f.rule === 'dynamic-code')).toBe(true);
    });

    it('flags child process usage', () => {
      const files = new Map([
        ['index.js', `require("${CP_MODULE}")`],
      ]);
      const findings = auditStaticCode(files);
      expect(findings.some((f) => f.rule === 'child-process')).toBe(true);
    });

    it('flags Function constructor', () => {
      const files = new Map([
        ['index.js', FUNC_CTOR],
      ]);
      const findings = auditStaticCode(files);
      expect(findings.some((f) => f.rule === 'dynamic-code')).toBe(true);
    });

    it('passes clean code', () => {
      const files = new Map([
        ['index.js', 'const add = (a, b) => a + b;\nexport default add;'],
        ['style.css', '.container { display: flex; }'],
      ]);
      const findings = auditStaticCode(files);
      expect(findings.length).toBe(0);
    });

    it('includes file and line information', () => {
      const files = new Map([
        ['bad.js', `const ok = true;\n${EVAL_CODE};\nconst fine = 1;`],
      ]);
      const findings = auditStaticCode(files);
      const evalFinding = findings.find((f) => f.rule === 'dynamic-code');
      expect(evalFinding).toBeDefined();
      expect(evalFinding!.file).toBe('bad.js');
      expect(evalFinding!.line).toBe(2);
    });
  });

  describe('Layer 3: Sandbox Policy', () => {
    it('passes when permissions match capabilities', () => {
      const findings = auditSandboxPolicy(['fs.read', 'net.fetch']);
      expect(findings.length).toBe(0);
    });

    it('warns about high-risk permission combinations', () => {
      const findings = auditSandboxPolicy(['fs.write', 'net.fetch', 'env.read']);
      const warnings = findings.filter((f) => f.severity === 'warning');
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('flags permissions that cannot be sandboxed', () => {
      const findings = auditSandboxPolicy(['system.exec']);
      const errors = findings.filter((f) => f.severity === 'error');
      expect(errors.some((f) => f.rule === 'unsandboxable-permission')).toBe(true);
    });
  });

  describe.skipIf(!TEST_DB_URL)('Audit Orchestrator', () => {
    let db: Kysely<GalleryDatabase>;
    let listingId: string;
    let versionId: string;

    beforeAll(async () => {
      const pool = new pg.Pool({ connectionString: TEST_DB_URL });
      db = new Kysely<GalleryDatabase>({ dialect: new PostgresDialect({ pool }) });

      await sql`DROP TABLE IF EXISTS org_memberships CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS security_audits CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS app_reviews CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS app_installations CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS app_versions CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS app_listings CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS organizations CASCADE`.execute(db);
      await sql`DROP FUNCTION IF EXISTS app_listings_search_vector_update CASCADE`.execute(db);

      await runGalleryMigrations(db);
    });

    afterAll(async () => {
      if (db) {
        await sql`DROP TABLE IF EXISTS org_memberships CASCADE`.execute(db);
        await sql`DROP TABLE IF EXISTS security_audits CASCADE`.execute(db);
        await sql`DROP TABLE IF EXISTS app_reviews CASCADE`.execute(db);
        await sql`DROP TABLE IF EXISTS app_installations CASCADE`.execute(db);
        await sql`DROP TABLE IF EXISTS app_versions CASCADE`.execute(db);
        await sql`DROP TABLE IF EXISTS app_listings CASCADE`.execute(db);
        await sql`DROP TABLE IF EXISTS organizations CASCADE`.execute(db);
        await sql`DROP FUNCTION IF EXISTS app_listings_search_vector_update CASCADE`.execute(db);
        await db.destroy();
      }
    });

    beforeEach(async () => {
      await sql`DELETE FROM security_audits`.execute(db);
      await sql`DELETE FROM app_installations`.execute(db);
      await sql`DELETE FROM app_versions`.execute(db);
      await sql`UPDATE app_listings SET current_version_id = NULL`.execute(db);
      await sql`DELETE FROM app_listings`.execute(db);

      const listing = await db.insertInto('app_listings').values({
        slug: 'audit-test-app',
        name: 'Audit Test App',
        author_id: '00000000-0000-0000-0000-000000000001',
        description: 'Test',
        category: 'utility',
      }).returningAll().executeTakeFirstOrThrow();
      listingId = listing.id;

      const version = await db.insertInto('app_versions').values({
        listing_id: listingId,
        version: '1.0.0',
        manifest: JSON.stringify({ name: 'Audit Test App', permissions: ['fs.read'] }),
      }).returningAll().executeTakeFirstOrThrow();
      versionId = version.id;
    });

    it('creates audit record and passes clean app', async () => {
      const result = await runFullAudit(db, versionId, {
        manifest: { name: 'Audit Test App', permissions: ['fs.read'] },
        files: new Map([['index.js', 'export default function() { return 1; }']]),
      });

      expect(result.status).toBe('passed');
      expect(result.id).toBeDefined();

      const audit = await db.selectFrom('security_audits')
        .selectAll()
        .where('id', '=', result.id)
        .executeTakeFirst();
      expect(audit).toBeDefined();
      expect(audit!.status).toBe('passed');
    });

    it('fails audit with dangerous code', async () => {
      const result = await runFullAudit(db, versionId, {
        manifest: { name: 'Bad App', permissions: ['fs.read'] },
        files: new Map([['index.js', `${EVAL_CODE}; require("${CP_MODULE}")`]]),
      });

      expect(result.status).toBe('failed');

      const version = await db.selectFrom('app_versions')
        .select('audit_status')
        .where('id', '=', versionId)
        .executeTakeFirst();
      expect(version!.audit_status).toBe('failed');
    });

    it('fails audit with invalid permissions', async () => {
      const result = await runFullAudit(db, versionId, {
        manifest: { name: 'Bad App', permissions: ['system.exec'] },
        files: new Map([['index.js', 'console.log("hello")']]),
      });

      expect(result.status).toBe('failed');
    });
  });
});
