#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat, mkdir, open, readFile, readdir, rename,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
const CHECKS = Object.freeze([
  'runtimeLive',
  'continuousOutput',
  'codingAgentPreserved',
  'twoDevicesOneRuntime',
  'detachPreservesRuntime',
  'renamePreservesIdentity',
  'bundleOnePreservesRuntime',
  'bundleTwoPreservesRuntime',
  'supervisorPreserved',
  'failedUpdatePreservesRuntime',
  'explicitRollbackPreservesRuntime',
  'daemonReloadPreservesRuntime',
  'forceRunAbsent',
  'journalPrivacy',
  'rebootStartsNoRuntime',
  'rebootShowsInterrupted',
  'explicitRecoverRestoresRuntime',
  'concurrentRecoverSingleUnit',
  'corruptionFallsBackFresh',
  'recoverDeleteCannotResurrect',
  'deleteWaitsForEmptyCgroup',
  'deleteRemovesRecoveryState',
]);
const EXPECTED_BINARY =
  '534455dc62c8e3753918d012547d10159ee07929f570a5873a754957502a49c4';
const MAX_BYTES = 128 * 1024;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const validHead = (value) => /^[0-9a-f]{40}$/.test(value);
async function safeFile(path, maxBytes = MAX_BYTES) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      before.size < 1 || before.size > maxBytes) {
    throw new Error('production_evidence_file_invalid');
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (before.dev !== opened.dev || before.ino !== opened.ino ||
        before.size !== opened.size || opened.nlink !== 1) {
      throw new Error('production_evidence_file_changed');
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
function validateSummary(value, expectedHead) {
  if (!value || Object.keys(value).sort().join(',') !==
      'checks,prHeadSha,privacyScan,schemaVersion,status,zellijBinarySha256' ||
      value.schemaVersion !== 1 || value.prHeadSha !== expectedHead ||
      value.status !== 'pass' || value.zellijBinarySha256 !== EXPECTED_BINARY ||
      !value.checks || Object.keys(value.checks).length !== CHECKS.length ||
      CHECKS.some((check) => value.checks[check] !== true) ||
      JSON.stringify(value.privacyScan) !==
        '{"status":"pass","findings":0}') {
    throw new Error('production_evidence_incomplete');
  }
  const encoded = JSON.stringify(value);
  if (/authorization|bearer|token=|\/home\/|(?:\d{1,3}\.){3}\d{1,3}/i.test(encoded)) {
    throw new Error('production_evidence_privacy');
  }
  return value;
}
async function validateDirectory(root, expectedHead) {
  if (!validHead(expectedHead)) throw new Error('production_evidence_head');
  const raw = await safeFile(join(resolve(root), 'summary.json'));
  let parsed;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch (error) {
    void error;
    throw new Error('production_evidence_json');
  }
  return { summary: validateSummary(parsed, expectedHead), digest: sha256(raw) };
}
async function writeSummary(root, head) {
  if (!validHead(head)) throw new Error('production_evidence_head');
  const checksRoot = join(resolve(root), 'checks');
  const entries = (await readdir(checksRoot)).sort();
  if (entries.length !== CHECKS.length ||
      entries.some((entry, index) => entry !== [...CHECKS].sort()[index])) {
    throw new Error('production_evidence_checks');
  }
  for (const check of entries) {
    const metadata = await lstat(join(checksRoot, check));
    if (!metadata.isFile() || metadata.isSymbolicLink() ||
        metadata.nlink !== 1 || metadata.size !== 0) {
      throw new Error('production_evidence_check_invalid');
    }
  }
  const binary = await readFile('/opt/matrix/bin/zellij');
  const binaryDigest = sha256(binary);
  if (binaryDigest !== EXPECTED_BINARY) {
    throw new Error('production_evidence_binary');
  }
  const summary = {
    schemaVersion: 1,
    prHeadSha: head,
    status: 'pass',
    zellijBinarySha256: binaryDigest,
    checks: Object.fromEntries(CHECKS.map((check) => [check, true])),
    privacyScan: { status: 'pass', findings: 0 },
  };
  const path = join(resolve(root), 'summary.json');
  const temporary = `${path}.next`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(summary, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  return await validateDirectory(root, head);
}
async function pack(root, head) {
  const { summary, digest } = await validateDirectory(root, head);
  const envelope = JSON.stringify({
    schemaVersion: 1,
    prHeadSha: head,
    summary,
    summarySha256: digest,
  });
  if (Buffer.byteLength(envelope) > MAX_BYTES) {
    throw new Error('production_evidence_oversized');
  }
  process.stdout.write(envelope);
}
async function unpack(envelopePath, parent, head) {
  if (!validHead(head)) throw new Error('production_evidence_head');
  const bytes = await safeFile(envelopePath);
  let envelope;
  try { envelope = JSON.parse(bytes.toString('utf8')); } catch (error) {
    void error;
    throw new Error('production_evidence_envelope');
  }
  if (envelope?.schemaVersion !== 1 ||
      Object.keys(envelope).sort().join(',') !==
        'prHeadSha,schemaVersion,summary,summarySha256' ||
      envelope.prHeadSha !== head ||
      envelope.summarySha256 !== sha256(
        Buffer.from(`${JSON.stringify(envelope.summary, null, 2)}\n`),
      )) {
    throw new Error('production_evidence_envelope');
  }
  validateSummary(envelope.summary, head);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const target = join(resolve(parent), `matrix-terminal-production-evidence-${head}`);
  await mkdir(target, { mode: 0o700 });
  const handle = await open(join(target, 'summary.json'), 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(envelope.summary, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  process.stdout.write(target);
}
const args = process.argv.slice(2);
if (args[0] === '--write-summary' && args.length === 3) {
  await writeSummary(args[1], args[2]);
} else if (args[0] === '--pack' && args.length === 3) {
  await pack(args[1], args[2]);
} else if (args[0] === '--unpack' && args.length === 4) {
  await unpack(args[1], args[2], args[3]);
} else if (args.length === 3 && args[1] === '--expected-head') {
  const result = await validateDirectory(args[0], args[2]);
  process.stdout.write(`${JSON.stringify({ summarySha256: result.digest })}\n`);
} else {
  throw new Error(`production_evidence_usage_${basename(process.argv[1] ?? '')}`);
}
