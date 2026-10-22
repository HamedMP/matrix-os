import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export function gmailPostgresFiles(root) {
  const files = [];
  function collect(directory) {
    const entries = readdirSync(path.join(root, directory), { withFileTypes: true });
    if (entries.length > 4096) throw Error('Gmail test inventory exceeds bounds');
    for (const entry of entries) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) collect(file);
      else if (entry.isFile() && /\.test\.tsx?$/.test(entry.name)) files.push(file);
    }
  }
  collect('tests/gateway/google-data');
  files.push('tests/gateway/google-broker-collection-startup.test.ts');
  for (const entry of readdirSync(path.join(root, 'tests/platform'), { withFileTypes: true })) {
    if (entry.isFile() && /^(?:ai-funded-(?:qualified-.+|route-binding|managed-route-client)|google-collection-admission)\.test\.ts$/.test(entry.name)) files.push(`tests/platform/${entry.name}`);
  }
  if (!files.length || files.length > 256 || files.some(file => lstatSync(path.join(root, file)).size > 1024 * 1024)) throw Error('Gmail test inventory exceeds bounds');
  return files.sort();
}

function disposableUrl(value) {
  try {
    const url = new URL(value ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !/(?:^|_)test(?:_|$)/.test(url.pathname.slice(1)) || url.search || url.hash) throw Error();
    return value;
  } catch (error) { throw Error('Disposable PostgreSQL configuration required'); }
}

function fixtureUrl(url, supplied) {
  const fixture = new URL(url); fixture.pathname = '/matrix_ci_platform_fixture_admin';
  if (supplied && new URL(supplied).href !== fixture.href) throw Error('Disposable PostgreSQL fixture authority mismatch');
  return fixture.href;
}

/** Native fixtures clone only this fixed disposable admin database. The enclosing
 * CI service owns its lifetime; never drop a shared host database here. */
export async function prepareGmailPostgres(env = process.env, createClient = options => new pg.Client(options)) {
  const url = disposableUrl(env.MATRIX_TEST_POSTGRES_URL);
  fixtureUrl(url, env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL);
  const client = createClient({ connectionString: url, connectionTimeoutMillis: 2000, statement_timeout: 5000,
    query_timeout: 7000, options: '-c lock_timeout=2000' });
  try {
    await client.connect();
    await client.query('SELECT pg_advisory_lock(551035509)');
    const found = await client.query("SELECT 1 FROM pg_database WHERE datname='matrix_ci_platform_fixture_admin'");
    if (!found.rows.length) await client.query('CREATE DATABASE matrix_ci_platform_fixture_admin');
  } finally { await client.end(); } // Ending the owned connection also releases its advisory lock.
}

/** Exact-source, nonpublishing CI. Never use platform/owner database secrets.
 * A stale report, a skipped assertion or a missing file cannot qualify the lane. */
export function runGmailPostgres(root = process.cwd(), env = process.env, execute = spawnSync,
  output = path.join(root, 'output/ci/gmail-postgres')) {
  const url = disposableUrl(env.MATRIX_TEST_POSTGRES_URL);
  const native = fixtureUrl(url, env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL);
  const files = gmailPostgresFiles(root);
  mkdirSync(output, { recursive: true });
  const report = path.join(output, 'results.json');
  rmSync(report, { force: true });
  const result = execute('pnpm', ['exec', 'vitest', 'run', ...files, '--maxWorkers=1', '--no-file-parallelism',
    '--reporter=default', '--reporter=json', `--outputFile.json=${report}`], {
    cwd: root, env: { ...env, MATRIX_PLATFORM_FIXTURE_POSTGRES_URL: native }, stdio: 'inherit', timeout: 8 * 60_000,
  });
  if (result.error || result.signal || result.status !== 0) throw Error('Gmail PostgreSQL execution failed');
  const data = JSON.parse(readFileSync(report, 'utf8'));
  if (!Array.isArray(data.testResults)) throw Error('Missing Gmail PostgreSQL results');
  const reported = data.testResults.map(file => path.relative(root, file.name).split(path.sep).join('/'));
  if (reported.length !== files.length || new Set(reported).size !== files.length || files.some(file => !reported.includes(file))) throw Error('Incomplete Gmail PostgreSQL results');
  let assertions = 0;
  for (const file of data.testResults) {
    if (!Array.isArray(file.assertionResults) || !file.assertionResults.length || file.assertionResults.some(assertion => assertion.status !== 'passed')) throw Error('Gmail PostgreSQL checks failed or skipped');
    assertions += file.assertionResults.length;
  }
  if (data.success !== true || data.numTotalTests !== assertions || data.numPassedTests !== assertions
    || data.numFailedTests !== 0 || data.numPendingTests !== 0) throw Error('Inconsistent Gmail PostgreSQL totals');
  return { files: files.length, assertions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await prepareGmailPostgres();
  console.info('Gmail PostgreSQL qualification:', runGmailPostgres());
}
