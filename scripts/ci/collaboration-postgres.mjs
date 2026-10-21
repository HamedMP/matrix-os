import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const fixtureDefinitions = new Set(['tests/gateway/collaboration-test-support.ts', 'tests/platform/collaboration-test-support.ts']);
const anchors = ['tests/gateway/personal-sync-share-inventory-postgres.test.ts',
  'tests/platform/collaboration-cutover-postgres.test.ts', 'tests/platform/organization-authority-postgres.test.ts'];
const testFile = /\.test\.tsx?$/;
const realFixture = /\bcreateReal(?:Platform)?CollaborationTestDatabase\b/;

function sources(root, directory = 'tests', result = new Map()) {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) sources(root, file, result);
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(file)) {
      if (result.size >= 10000 || lstatSync(path.join(root, file)).size > 4 * 1024 ** 2) throw Error('Test source inventory exceeds bounds');
      result.set(file, readFileSync(path.join(root, file), 'utf8'));
    }
  }
  return result;
}

function discover(root) {
  const files = sources(root);
  const real = new Set([...files].filter(([file, source]) => !fixtureDefinitions.has(file) && realFixture.test(source)).map(([file]) => file));
  const imports = new Map([...files].map(([file, source]) => [file,
    ts.preProcessFile(source, true, true).importedFiles.flatMap(({ fileName }) => {
      if (!fileName.startsWith('.')) return [];
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), fileName));
      return [base, base.replace(/\.[cm]?jsx?$/, '.ts'), base.replace(/\.jsx?$/, '.tsx'), `${base}.ts`, `${base}/index.ts`].filter(candidate => files.has(candidate));
    })]));
  // Follow wrappers/re-exports conservatively, without promoting the pure-PGlite
  // exports of the two fixture-definition modules to real-server consumers.
  let changed;
  do {
    changed = false;
    for (const [file, dependencies] of imports) if (!real.has(file) && dependencies.some(dependency => real.has(dependency))) {
      real.add(file); changed = true;
    }
  } while (changed);
  return [...new Set([...real].filter(file => testFile.test(file)).concat(anchors))].sort();
}

export function collaborationPostgresFiles(root) {
  const files = JSON.parse(readFileSync(path.join(root, 'scripts/ci/collaboration-postgres-files.json'), 'utf8'));
  if (!Array.isArray(files) || !files.length || files.length > 512
    || files.some(file => typeof file !== 'string' || !/^tests\/[a-zA-Z0-9_./-]+\.test\.tsx?$/.test(file)
      || file.split('/').some(part => part === '..' || part === '.') || !lstatSync(path.join(root, file)).isFile())
    || new Set(files).size !== files.length || files.some((file, index) => index && files[index - 1] >= file)) throw Error('Invalid sorted collaboration PostgreSQL manifest');
  const discovered = discover(root);
  const missing = discovered.filter(file => !files.includes(file));
  const stale = files.filter(file => !discovered.includes(file));
  if (missing.length || stale.length) throw Error(`Collaboration PostgreSQL manifest drift; missing: ${missing.join(', ')}; stale: ${stale.join(', ')}`);
  return files;
}

function readReport(root, report, selected) {
  const data = JSON.parse(readFileSync(report, 'utf8'));
  if (!data || !Array.isArray(data.testResults)) throw Error('Missing collaboration PostgreSQL file results');
  const reported = data.testResults.map(file => path.relative(root, file.name).split(path.sep).join('/'));
  if (reported.length !== selected.length || new Set(reported).size !== reported.length
    || selected.some(file => !reported.includes(file))) throw Error('Incomplete collaboration PostgreSQL file results');
  let assertions = 0;
  for (const file of data.testResults) {
    if (!Array.isArray(file.assertionResults) || !file.assertionResults.length
      || file.assertionResults.some(assertion => assertion.status !== 'passed')) throw Error('Collaboration PostgreSQL checks failed, skipped or were not collected');
    assertions += file.assertionResults.length;
  }
  if (data.success !== true || data.numTotalTests !== assertions || data.numPassedTests !== assertions
    || data.numFailedTests !== 0 || data.numPendingTests !== 0) throw Error('Inconsistent collaboration PostgreSQL assertion totals');
  return assertions;
}

export function runCollaborationPostgres(root = process.cwd(), env = process.env, execute = spawnSync,
  output = path.join(root, 'output/ci/collaboration-postgres')) {
  if (!env.MATRIX_TEST_POSTGRES_URL?.trim()) throw Error('MATRIX_TEST_POSTGRES_URL is required for disposable PostgreSQL qualification');
  const files = collaborationPostgresFiles(root);
  mkdirSync(output, { recursive: true });
  let failed = false, assertions = 0;
  const batches = [];
  for (let offset = 0; offset < files.length; offset += 9) {
    const selected = files.slice(offset, offset + 9), report = path.join(output, `batch-${1 + offset / 9}.json`);
    // A stale passing report must never stand in for this execution.
    if (existsSync(report)) throw Error('Collaboration PostgreSQL report already exists');
    const args = ['exec', 'vitest', 'run', ...selected, '--maxWorkers=1', '--no-file-parallelism',
      '--reporter=default', '--reporter=json', `--outputFile.json=${report}`];
    const result = execute('pnpm', args, { cwd: root, env, stdio: 'inherit' });
    let error;
    try { assertions += readReport(root, report, selected); }
    catch (cause) { error = cause instanceof Error ? cause.message : 'Invalid PostgreSQL qualification report'; }
    if (result.status !== 0 || error) {
      failed = true;
      console.error(`Collaboration PostgreSQL batch ${1 + offset / 9} failed: ${error ?? `exit ${result.status ?? 'unknown'}`}`);
    }
    batches.push({ files: selected, exitCode: result.status ?? null, report: path.basename(report), error });
  }
  writeFileSync(path.join(output, 'inventory.json'), JSON.stringify({ files, qualified: !failed,
    verifiedPassedAssertions: assertions, batches }, null, 2) + '\n');
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = runCollaborationPostgres(); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Collaboration PostgreSQL qualification failed'); process.exitCode = 1; }
}
