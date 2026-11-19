// Bootstrap/recovery only: read ../README.md; resources already exist.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';

const require = createRequire(process.env.MATRIX_PREVIEW_CANDIDATE_ROOT + '/package.json');
const pg = require('pg');
const project = 'matrix-os-1144';
const targetName = 'matrix_pair_preview';
const secretName = 'matrix-pair-preview-database-url';
const operatorUrl = execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest',
  '--secret=platform-database-url', `--project=${project}`], { encoding: 'utf8', timeout: 15_000 }).trim();
const normalized = new URL(operatorUrl);
if (!['postgres:', 'postgresql:'].includes(normalized.protocol)) throw new Error('Invalid operator URL');
// Preserve the pg 8 verified-TLS behavior explicitly, without a weaker SSL mode.
if (['prefer', 'require', 'verify-ca'].includes(normalized.searchParams.get('sslmode'))) normalized.searchParams.set('sslmode', 'verify-full');
const connectionString = normalized.href;
const operator = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000, lock_timeout: 3_000, application_name: 'eng-418-preview-bootstrap' });
const receipt = { role: targetName, database: targetName, secret: secretName,
  authorization: 'Explicit requester approval, 15 November 2026',
  secretCreated: false, roleCreated: false, databaseCreated: false, productionRecordsRead: false,
  productionGrantsChanged: false, state: 'preflight' };
const receiptPath = new URL('./database-bootstrap-receipt.json', import.meta.url);
let receiptOwned = false;
async function record() {
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n',
    { flag: receiptOwned ? 'w' : 'wx', mode: 0o600 });
  receiptOwned = true;
}

try {
  await operator.connect();
  const { rows: [identity] } = await operator.query(`SELECT current_database() AS database, session_user AS role,
    rolsuper, rolcreatedb, rolcreaterole FROM pg_catalog.pg_roles WHERE rolname = session_user`);
  if (identity.database === targetName || identity.role === targetName || !identity.rolcreatedb || !identity.rolcreaterole) {
    throw new Error('Operator identity or capabilities differ from the approved preflight');
  }
  const { rows: [existing] } = await operator.query(`SELECT
    EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=$1) AS role_exists,
    EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datname=$1) AS database_exists`, [targetName]);
  if (existing.role_exists || existing.database_exists) throw new Error('Unexpected existing target; manual reconciliation required');
  await record();
  const password = randomBytes(48).toString('base64url');
  const targetUrl = new URL(connectionString);
  targetUrl.username = targetName; targetUrl.password = password; targetUrl.pathname = `/${targetName}`;
  const store = execFileSync('gcloud', ['secrets', 'create', secretName, `--project=${project}`,
    '--replication-policy=automatic', '--labels=purpose=collaboration-preview,issue=eng-418', '--data-file=-'],
    { input: targetUrl.href, encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] });
  receipt.secretCreated = true; receipt.state = 'secret-stored'; await record();
  await operator.query('BEGIN');
  try {
    await operator.query(`CREATE ROLE ${pg.escapeIdentifier(targetName)} LOGIN PASSWORD ${pg.escapeLiteral(password)}
      NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20`);
    await operator.query(`COMMENT ON ROLE ${pg.escapeIdentifier(targetName)} IS 'ENG-418 isolated collaboration preview; no customer grants'`);
    await operator.query('COMMIT');
  } catch (error) { await operator.query('ROLLBACK'); throw error; }
  receipt.roleCreated = true; receipt.state = 'restricted-role-created'; await record();
  // Catalog-only checks. No production records or existing grants are changed.
  const { rows: [access] } = await operator.query(`SELECT
    EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      AND pg_catalog.has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS table_access,
    EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      AND pg_catalog.has_schema_privilege($1,n.oid,'CREATE')) AS schema_create,
    pg_catalog.has_database_privilege($1,current_database(),'CREATE') AS database_create`, [targetName]);
  if (access.table_access || access.schema_create || access.database_create) throw new Error('Default grants cross the required isolation boundary; stop for administrator review');
  receipt.productionPrivilegeChecks = access; await record();
  // PostgreSQL forbids CREATE DATABASE inside a transaction. The durable receipt
  // retains the exact restricted role/secret if this DDL fails; no broad retry.
  await operator.query(`CREATE DATABASE ${pg.escapeIdentifier(targetName)} OWNER ${pg.escapeIdentifier(targetName)} TEMPLATE template0`);
  receipt.databaseCreated = true; receipt.state = 'database-created'; await record();
  await operator.query('BEGIN');
  try {
    await operator.query(`REVOKE ALL ON DATABASE ${pg.escapeIdentifier(targetName)} FROM PUBLIC`);
    await operator.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${pg.escapeIdentifier(targetName)} TO ${pg.escapeIdentifier(targetName)}`);
    await operator.query(`COMMENT ON DATABASE ${pg.escapeIdentifier(targetName)} IS 'ENG-418 isolated preview platform metadata; no customer data'`);
    await operator.query('COMMIT');
  } catch (error) { await operator.query('ROLLBACK'); throw error; }
  receipt.state = 'created-awaiting-migrations'; await record();
  console.log(JSON.stringify(receipt));
} catch (error) {
  receipt.state = 'needs-reconciliation';
  receipt.errorType = error?.name ?? 'UnknownError';
  receipt.errorCode = typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : null;
  if (receiptOwned) await record();
  console.error(JSON.stringify(receipt));
  process.exitCode = 1;
} finally { await operator.end(); }
