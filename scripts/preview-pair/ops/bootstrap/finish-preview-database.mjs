// Bootstrap/recovery only: read ../README.md; resources already exist.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
const pg = createRequire(process.env.MATRIX_PREVIEW_CANDIDATE_ROOT + '/package.json')('pg');
const targetName = 'matrix_pair_preview';
const project = 'matrix-os-1144';
const load = name => execFileSync('gcloud', ['secrets', 'versions', 'access', '1',
  `--secret=${name}`, `--project=${project}`], { encoding: 'utf8', timeout: 15_000 }).trim();
const normalize = raw => {
  const u = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(u.protocol)) throw new Error('Unexpected database URL');
  if (['prefer', 'require', 'verify-ca'].includes(u.searchParams.get('sslmode'))) u.searchParams.set('sslmode', 'verify-full');
  return u;
};
const operatorUrl = normalize(execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest',
  '--secret=platform-database-url', `--project=${project}`], { encoding: 'utf8', timeout: 15_000 }).trim());
const targetUrl = normalize(load('matrix-pair-preview-database-url'));
if (targetUrl.hostname !== operatorUrl.hostname || targetUrl.port !== operatorUrl.port
  || targetUrl.username !== targetName || targetUrl.pathname !== `/${targetName}`
  || operatorUrl.username === targetName || operatorUrl.pathname === `/${targetName}`) throw new Error('Target binding mismatch');
const path = new URL('./database-bootstrap-receipt.json', import.meta.url);
const receipt = JSON.parse(await readFile(path, 'utf8'));
if (!receipt.secretCreated || !receipt.roleCreated || receipt.databaseCreated || receipt.role !== targetName
  || receipt.productionPrivilegeChecks?.table_access !== false || receipt.productionPrivilegeChecks?.schema_create !== false
  || receipt.productionPrivilegeChecks?.database_create !== false) throw new Error('Unexpected bootstrap receipt');
const options = { connectionTimeoutMillis: 5_000, statement_timeout: 10_000, lock_timeout: 3_000,
  application_name: 'eng-418-preview-bootstrap-finish' };
const operator = new pg.Client({ ...options, connectionString: operatorUrl.href });
let databaseAdmin;
try {
  await operator.connect();
  const { rows: [role] } = await operator.query(`SELECT rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
    rolconnlimit,pg_catalog.shobj_description(oid,'pg_authid') AS comment FROM pg_catalog.pg_roles WHERE rolname=$1`, [targetName]);
  if (!role || ['rolsuper','rolinherit','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'].some(name => role[name])
    || role.rolconnlimit !== 20 || role.comment !== 'ENG-418 isolated collaboration preview; no customer grants') throw new Error('Restricted role changed');
  const { rows: [existing] } = await operator.query('SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datname=$1) AS exists', [targetName]);
  if (existing.exists) throw new Error('Unexpected existing database; reconcile before retry');
  // Keep the existing operator as owner. No SET ROLE or operator membership
  // change; the runtime login receives fewer administrative rights than planned.
  await operator.query(`CREATE DATABASE ${pg.escapeIdentifier(targetName)} TEMPLATE template0`);
  receipt.databaseCreated = true; receipt.state = 'database-created-awaiting-grants';
  receipt.ownership = 'existing-operator'; receipt.previewRoleOwnsDatabase = false;
  await writeFile(path, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  await operator.query('BEGIN');
  try {
    await operator.query(`REVOKE ALL ON DATABASE ${pg.escapeIdentifier(targetName)} FROM PUBLIC`);
    await operator.query(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${pg.escapeIdentifier(targetName)} TO ${pg.escapeIdentifier(targetName)}`);
    await operator.query(`COMMENT ON DATABASE ${pg.escapeIdentifier(targetName)} IS 'ENG-418 isolated preview platform metadata; no customer data'`);
    await operator.query('COMMIT');
  } catch (error) { await operator.query('ROLLBACK'); throw error; }
  const adminUrl = new URL(operatorUrl.href); adminUrl.pathname = `/${targetName}`;
  databaseAdmin = new pg.Client({ ...options, connectionString: adminUrl.href });
  await databaseAdmin.connect();
  await databaseAdmin.query('BEGIN');
  try {
    await databaseAdmin.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await databaseAdmin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${pg.escapeIdentifier(targetName)}`);
    await databaseAdmin.query('COMMIT');
  } catch (error) { await databaseAdmin.query('ROLLBACK'); throw error; }
  receipt.state = 'created-awaiting-migrations'; delete receipt.errorCode; delete receipt.errorType;
  receipt.productionGrantsChanged = false; receipt.operatorMembershipsChanged = false;
  await writeFile(path, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(receipt));
} catch (error) {
  receipt.state = 'needs-reconciliation'; receipt.errorType = error?.name ?? 'UnknownError';
  receipt.errorCode = typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : null;
  await writeFile(path, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.error(JSON.stringify(receipt)); process.exitCode = 1;
} finally { if (databaseAdmin) await databaseAdmin.end(); await operator.end(); }
