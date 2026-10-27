import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

// Explicit ownership: newly discovered real-server suites must be assigned to a
// hosted lane before qualification succeeds. Existing hosted selections stay put.
export const REMAINING_POSTGRES_FILES = [
  'tests/gateway/bots/custom-direct-chat-postgres.test.ts',
  'tests/gateway/bots/deployed-v6-schema-postgres.test.ts',
  'tests/gateway/bots/interactions-repository.test.ts',
  'tests/gateway/bots/managed-custom-recovery.test.ts',
  'tests/gateway/bots/memory-repository.test.ts',
  'tests/gateway/bots/sessions-repository.test.ts',
  'tests/gateway/bots/tasks-repository.test.ts',
  'tests/gateway/chat-order-title.test.ts',
  'tests/gateway/jev-inbox-batch-postgres.test.ts',
  'tests/gateway/jev-repository-postgres.test.ts',
  'tests/gateway/sites-bootstrap-postgres.test.ts',
  'tests/gateway/slack-pi-integration.test.ts',
  'tests/platform/sites-postgres.test.ts',
  'tests/platform/sites-publish-admission-postgres.test.ts',
  'tests/platform/sites-recovery-postgres.test.ts',
  'tests/platform/speech-postgres-concurrency.test.ts',
  'tests/platform/trial-retention-postgres.test.ts',
];
const testFile = /\.(?:test|integration)\.tsx?$/;
const fixtureDefinitions = new Set(['tests/gateway/collaboration-test-support.ts',
  'tests/platform/collaboration-test-support.ts', 'tests/gateway/bots/bot-state-support.ts']);
const environmentNames = new Set(['MATRIX_TEST_POSTGRES_URL', 'CHAT_TEST_DATABASE_URL']);
const realFactory = /^createReal[A-Za-z]*(?:Database|Db)$/;

function sourceInventory(root, directory = 'tests', files = new Map()) {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) sourceInventory(root, file, files);
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(file)) {
      if (files.size >= 10000 || lstatSync(path.join(root, file)).size > 4 * 1024 ** 2) throw Error('PostgreSQL source inventory exceeds bounds');
      files.set(file, readFileSync(path.join(root, file), 'utf8'));
    }
  }
  return files;
}
function modulePath(file, imported, sources) {
  if (!imported.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), imported));
  return [base, base.replace(/\.[cm]?jsx?$/, '.ts'), base.replace(/\.jsx?$/, '.tsx'), `${base}.ts`, `${base}/index.ts`]
    .find(candidate => sources.has(candidate));
}
function environmentName(node) {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return null;
  const parent = node.expression;
  if (!ts.isPropertyAccessExpression(parent) || !ts.isIdentifier(parent.expression)
    || parent.expression.text !== 'process' || parent.name.text !== 'env') return null;
  const value = ts.isPropertyAccessExpression(node) ? node.name.text
    : node.argumentExpression && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : null;
  return environmentNames.has(value) ? value : null;
}
function inspectSource(file, source, sources) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const environments = new Set(), factories = new Set(), imports = [], aliases = new Map();
  for (const node of tree.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = modulePath(file, node.moduleSpecifier.text, sources);
      if (target) imports.push(target);
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const specifier of bindings.elements) {
        aliases.set(specifier.name.text, (specifier.propertyName ?? specifier.name).text);
      }
    }
  }
  function visit(node) {
    const environment = environmentName(node);
    if (environment) environments.add(environment);
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression) ? aliases.get(node.expression.text) ?? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
      if (realFactory.test(name)) factories.add(name);
    }
    node.forEachChild(visit);
  }
  visit(tree);
  return { environments, factories, imports };
}
function validateFiles(files, sources, label) {
  if (!Array.isArray(files) || !files.length || files.length > 512 || new Set(files).size !== files.length
    || files.some((file, index) => typeof file !== 'string' || !/^tests\/[a-zA-Z0-9_./-]+\.(?:test|integration)\.tsx?$/.test(file)
      || file.split('/').some(part => part === '..' || part === '.') || !sources.has(file) || (index && files[index - 1] >= file))) {
    throw Error(`Invalid sorted ${label} PostgreSQL inventory`);
  }
}

export function remainingPostgresInventory(root = process.cwd(), remainingFiles = REMAINING_POSTGRES_FILES) {
  const sources = sourceInventory(root);
  validateFiles(remainingFiles, sources, 'remaining');
  const collaborationFiles = JSON.parse(readFileSync(path.join(root, 'scripts/ci/collaboration-postgres-files.json'), 'utf8'));
  validateFiles(collaborationFiles, sources, 'collaboration');
  const workflow = parseYaml(readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
  const steps = workflow?.jobs?.['funded-postgres']?.steps ?? [];
  // Recognize canonical command lines, not a filename mentioned by echo/comment.
  // Dynamic shell selection is deliberately not evidence of a hosted assignment.
  const commands = steps.filter(step => step.if !== false && !['false', '${{ false }}'].includes(step.if))
    .flatMap(step => [...String(step.run ?? '').replace(/\\\r?\n/g, ' ').matchAll(/(?:^|\n)[ \t]*pnpm[ \t]+exec[ \t]+vitest[ \t]+run[ \t]+([^\n]+)/g)]
      .map(match => match[1].split('#')[0])).join('\n');
  const patterns = [...commands.matchAll(/(?:^|\s)(tests\/[a-zA-Z0-9_./*?-]+\.test\.tsx?)(?=\s|$)/g)].map(match => match[1]);
  if (!patterns.length) throw Error('Funded PostgreSQL hosted selection is missing');
  const fundedFiles = [...sources.keys()].filter(file => patterns.some(pattern => path.matchesGlob(file, pattern)));
  const funded = new Set(fundedFiles), collaboration = new Set(collaborationFiles), remaining = new Set(remainingFiles);
  const overlap = remainingFiles.filter(file => funded.has(file) || collaboration.has(file));
  if (overlap.length) throw Error(`Remaining PostgreSQL files already assigned to a hosted lane: ${overlap.join(', ')}`);
  const inspected = new Map([...sources].map(([file, source]) => [file, inspectSource(file, source, sources)]));
  const requires = new Set([...inspected].filter(([, row]) => row.environments.size || row.factories.size).map(([file]) => file));
  let changed;
  do {
    changed = false;
    for (const [file, row] of inspected) if (!requires.has(file)
      && row.imports.some(dependency => !fixtureDefinitions.has(dependency) && !testFile.test(dependency) && requires.has(dependency))) {
      requires.add(file); changed = true;
    }
  } while (changed);
  const requirements = [...requires].filter(file => testFile.test(file)).sort();
  const missing = requirements.filter(file => !funded.has(file) && !collaboration.has(file) && !remaining.has(file));
  const stale = remainingFiles.filter(file => !requires.has(file));
  if (missing.length) throw Error(`Unassigned real PostgreSQL suites: ${missing.join(', ')}`);
  if (stale.length) throw Error(`Stale remaining PostgreSQL suites: ${stale.join(', ')}`);
  return { files: [...remainingFiles], requirements: requirements.map(file => ({ file,
    environments: [...inspected.get(file).environments].sort(), factories: [...inspected.get(file).factories].sort() })),
    existingHostedOverlaps: fundedFiles.filter(file => collaboration.has(file)).sort(),
    legacyEnvironment: { CHAT_TEST_DATABASE_URL: 'MATRIX_TEST_POSTGRES_URL' } };
}
function disposableUrl(value) {
  let parsed;
  try { parsed = new URL(value); }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    console.error('PostgreSQL test URL parsing failed:', error.name);
    throw Error('Disposable loopback PostgreSQL URL required');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !['127.0.0.1', '[::1]'].includes(parsed.hostname)
    || !/^\/[a-zA-Z0-9_]+_test$/.test(parsed.pathname) || parsed.search || parsed.hash) {
    throw Error('Disposable loopback _test PostgreSQL URL without options required');
  }
  return parsed.href;
}
function passedAssertions(root, report, files) {
  const data = JSON.parse(readFileSync(report, 'utf8'));
  if (!data || !Array.isArray(data.testResults)) throw Error('Missing PostgreSQL file results');
  const reported = data.testResults.map(file => path.relative(root, file.name).split(path.sep).join('/'));
  if (reported.length !== files.length || new Set(reported).size !== files.length || files.some(file => !reported.includes(file))) {
    throw Error('Incomplete PostgreSQL file results');
  }
  let assertions = 0;
  for (const file of data.testResults) {
    if (!Array.isArray(file.assertionResults) || !file.assertionResults.length
      || file.assertionResults.some(assertion => assertion.status !== 'passed')) throw Error('PostgreSQL assertions failed, skipped or were not collected');
    assertions += file.assertionResults.length;
  }
  if (data.success !== true || data.numTotalTests !== assertions || data.numPassedTests !== assertions
    || data.numFailedTests !== 0 || data.numPendingTests !== 0) throw Error('Inconsistent PostgreSQL assertion totals');
  return assertions;
}
export function runRemainingPostgres(root = process.cwd(), env = process.env, execute = spawnSync,
  output = path.join(root, 'output/ci/remaining-postgres'), files = REMAINING_POSTGRES_FILES, now = Date.now) {
  const url = disposableUrl(env.MATRIX_TEST_POSTGRES_URL);
  const inventory = remainingPostgresInventory(root, files);
  mkdirSync(output, { recursive: true });
  // This alias has one reviewed owner: chat-order-title's independent-pool variant.
  const childEnv = { ...env, MATRIX_TEST_POSTGRES_URL: url, CHAT_TEST_DATABASE_URL: url };
  let failed = false, assertions = 0;
  const batches = [];
  const deadline = now() + 120000;
  for (let offset = 0; offset < files.length; offset += 4) {
    const selected = files.slice(offset, offset + 4), report = path.join(output, `batch-${1 + offset / 4}.json`);
    if (existsSync(report)) throw Error('Remaining PostgreSQL report already exists');
    const args = ['exec', 'vitest', 'run', ...selected, '--maxWorkers=1', '--no-file-parallelism',
      '--reporter=default', '--reporter=json', `--outputFile.json=${report}`];
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      failed = true;
      batches.push({ files: selected, exitCode: null, report: null, error: 'Total PostgreSQL runner budget exceeded' });
      continue;
    }
    const processGroup = process.platform !== 'win32';
    const result = execute('pnpm', args, { cwd: root, env: childEnv, stdio: 'inherit',
      timeout: Math.min(60000, remainingMs), killSignal: 'SIGKILL', detached: processGroup });
    if (processGroup && result.error?.code === 'ETIMEDOUT' && result.pid) {
      try { process.kill(-result.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') console.error('PostgreSQL batch process cleanup failed', error.code); }
    }
    let error;
    try { assertions += passedAssertions(root, report, selected); }
    catch (cause) { error = cause instanceof Error ? cause.message : 'Invalid PostgreSQL qualification report'; }
    if (now() > deadline) error = 'Total PostgreSQL runner budget exceeded';
    if (result.status !== 0 || error) {
      failed = true;
      console.error(`Remaining PostgreSQL batch ${1 + offset / 4} failed: ${error ?? `exit ${result.status ?? 'unknown'}`}`);
    }
    batches.push({ files: selected, exitCode: result.status ?? null, report: path.basename(report), error });
  }
  writeFileSync(path.join(output, 'inventory.json'), JSON.stringify({ ...inventory, qualified: !failed,
    verifiedPassedAssertions: assertions, batches }, null, 2) + '\n');
  return failed ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = runRemainingPostgres(); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Remaining PostgreSQL qualification failed'); process.exitCode = 1; }
}
