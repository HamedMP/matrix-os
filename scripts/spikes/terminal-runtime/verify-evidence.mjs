#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join, posix, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_EVIDENCE_FILE_BYTES = 256 * 1024;
export const MAX_EVIDENCE_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_EVIDENCE_FILES = 256;

const REQUIRED_S1_CHECKS = [
  'keeperMainPid',
  'runtimeCgroupMembers',
  'gatewayOutsideCgroup',
  'attachOutsideCgroup',
  'detachPreservesPids',
  'gatewayRestartPreservesPids',
  'gatewayCrashPreservesPids',
  'shellRestartPreservesPids',
  'stopEmptiesCgroup',
  'keeperLossDeterministic',
  'serverLossDeterministic',
  'readinessGated',
  'layeredMemoryHigh',
];

const REQUIRED_S2_CHECKS = [
  'exactOptionSyntax',
  'cacheMappedByRuntime',
  'layoutRestored',
  'viewportRestored',
  'scrollbackBounded',
  'lossWindowBounded',
  'commandsConfirmationGated',
  'forceRunAbsent',
  'corruptionFallback',
  'deletionComplete',
  'diskAccountingBounded',
  'liveSerializationDisableSafe',
];

const SUMMARY_KEYS = [
  'schemaVersion',
  'prHeadSha',
  'zellijVersion',
  'ubuntuVersion',
  'systemdVersion',
  'kernelVersion',
  's1',
  's2',
  'privacyScan',
  'files',
  'totalBytes',
];

const PRIVACY_PATTERNS = [
  /authorization\s*:\s*bearer\s+\S+/i,
  /\b(?:access[_-]?token|api[_-]?key|password|secret|token)\s*[=:]\s*\S+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:gh[opsu]_[A-Za-z0-9]{8,}|sk-(?:live|test|proj)-[A-Za-z0-9_-]{8,}|pk_(?:live|test)_[A-Za-z0-9]{8,})\b/,
  /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/,
  /\/home\/[A-Za-z0-9._-]+(?:\/[^\s"']*)?/,
];

function fail(code) {
  throw new Error(code);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isBoundedText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000\r\n]/.test(value);
}

function validateGate(value, requiredChecks) {
  if (!hasExactKeys(value, ['status', 'checks']) || value.status !== 'pass' || !isRecord(value.checks)) {
    fail('evidence_gate_failed');
  }
  if (!hasExactKeys(value.checks, requiredChecks)) fail('evidence_gate_failed');
  if (requiredChecks.some((check) => value.checks[check] !== true)) fail('evidence_gate_failed');
}

function validateRelativePath(value) {
  if (!isBoundedText(value, 240) || value.includes('\\') || value.startsWith('/')) {
    fail('evidence_file_path');
  }
  const normalized = posix.normalize(value);
  if (
    normalized !== value ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    !/^[A-Za-z0-9._/-]+$/.test(normalized)
  ) {
    fail('evidence_file_path');
  }
  return normalized;
}

async function readNoFollow(path, maxBytes) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error) fail('evidence_file_type');
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) fail('evidence_file_type');
    if (stat.size > maxBytes) fail('evidence_file_size');
    return { body: await handle.readFile(), stat };
  } finally {
    await handle.close();
  }
}

async function inventory(root, relative = '') {
  const directory = relative ? join(root, relative) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const child = join(root, childRelative);
    const stat = await lstat(child);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) fail('evidence_file_type');
    if (stat.isDirectory()) {
      files.push(...await inventory(root, childRelative));
    } else {
      if (stat.nlink !== 1) fail('evidence_file_type');
      files.push(childRelative.split(sep).join('/'));
    }
    if (files.length > MAX_EVIDENCE_FILES + 1) fail('evidence_file_count');
  }
  return files;
}

function scanPrivacy(body) {
  const text = body.toString('utf8');
  if (Buffer.from(text, 'utf8').compare(body) !== 0) fail('evidence_utf8');
  if (PRIVACY_PATTERNS.some((pattern) => pattern.test(text))) fail('evidence_privacy');
}

function ignorableDiagnosticError(error) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
  return code === 'ENOENT' || (error instanceof Error && error.message === 'evidence_file_type');
}

export async function reportGateChecks(inputRoot) {
  const root = resolve(inputRoot);
  const summaryResult = await readNoFollow(join(root, 'summary.json'), MAX_EVIDENCE_FILE_BYTES);
  scanPrivacy(summaryResult.body);
  let summary;
  try {
    summary = JSON.parse(summaryResult.body.toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) fail('evidence_summary_json');
    throw error;
  }
  const failures = [];
  for (const [gate, requiredChecks] of [
    ['s1', REQUIRED_S1_CHECKS],
    ['s2', REQUIRED_S2_CHECKS],
  ]) {
    const checks = isRecord(summary?.[gate]) && isRecord(summary[gate].checks)
      ? summary[gate].checks
      : {};
    for (const check of requiredChecks) {
      if (checks[check] !== true) failures.push(`${gate}:${check}=fail`);
    }
  }
  const startupPath = join(root, 's1', 'base-startup-failure.json');
  try {
    const startupStat = await lstat(startupPath);
    if (!startupStat.isFile() || startupStat.isSymbolicLink() || startupStat.nlink !== 1) {
      fail('evidence_file_type');
    }
    const startupResult = await readNoFollow(startupPath, 4096);
    scanPrivacy(startupResult.body);
    let startup;
    try {
      startup = JSON.parse(startupResult.body.toString('utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) fail('evidence_summary_json');
      throw error;
    }
    const stages = new Set(['descriptor', 'launch', 'cgroup', 'readiness', 'notify']);
    const codes = new Set([
      'runtime_id', 'descriptor_schema', 'descriptor_runtime', 'descriptor_cwd',
      'descriptor_intent', 'descriptor_size', 'client_exit', 'cgroup_unified',
      'cgroup_unit', 'readiness_timeout', 'startup_failed',
    ]);
    const baseShape = hasExactKeys(startup, ['stage', 'code']);
    const clientExitShape = hasExactKeys(startup, ['stage', 'code', 'exitCode', 'signal']) &&
      startup.code === 'client_exit' && Number.isInteger(startup.exitCode) &&
      startup.exitCode >= 0 && startup.exitCode <= 255 && Number.isInteger(startup.signal) &&
      startup.signal >= 0 && startup.signal <= 255;
    if ((baseShape || clientExitShape) && stages.has(startup.stage) && codes.has(startup.code)) {
      failures.push(`s1:startup=${startup.stage}/${startup.code}`);
      if (clientExitShape) failures.push(`s1:pty-exit=${startup.exitCode}/${startup.signal}`);
    }
  } catch (error) {
    if (!ignorableDiagnosticError(error)) throw error;
  }
  const unitPath = join(root, 's1', 'base-startup-unit.txt');
  try {
    const unitStat = await lstat(unitPath);
    if (!unitStat.isFile() || unitStat.isSymbolicLink() || unitStat.nlink !== 1) {
      fail('evidence_file_type');
    }
    const unitResult = await readNoFollow(unitPath, 4096);
    scanPrivacy(unitResult.body);
    const fields = {};
    for (const line of unitResult.body.toString('utf8').trim().split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z]+)=([A-Za-z0-9-]+)$/);
      if (!match || Object.hasOwn(fields, match[1])) fail('evidence_summary_schema');
      fields[match[1]] = match[2];
    }
    const activeStates = new Set(['inactive', 'failed', 'activating', 'deactivating', 'active']);
    const subStates = new Set([
      'dead', 'failed', 'start', 'start-pre', 'start-post', 'running', 'stop',
      'stop-sigterm', 'stop-sigkill', 'stop-post', 'auto-restart',
    ]);
    const results = new Set([
      'success', 'exit-code', 'signal', 'core-dump', 'watchdog', 'start-limit-hit',
      'timeout', 'resources', 'protocol',
    ]);
    if (
      hasExactKeys(fields, ['ActiveState', 'SubState', 'Result', 'ExecMainCode', 'ExecMainStatus']) &&
      activeStates.has(fields.ActiveState) && subStates.has(fields.SubState) &&
      results.has(fields.Result) && /^[0-3]$/.test(fields.ExecMainCode) &&
      /^(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(fields.ExecMainStatus)
    ) {
      failures.push(
        `s1:unit=${fields.ActiveState}/${fields.SubState}/${fields.Result}/${fields.ExecMainCode}/${fields.ExecMainStatus}`,
      );
    }
  } catch (error) {
    if (!ignorableDiagnosticError(error)) throw error;
  }
  const rolesPath = join(root, 's1', 'base-runtime-roles.json');
  try {
    const rolesResult = await readNoFollow(rolesPath, 4096);
    scanPrivacy(rolesResult.body);
    const roles = JSON.parse(rolesResult.body.toString('utf8'));
    const checkpoints = new Set(['initial', 'detach', 'gateway-restart', 'gateway-crash', 'shell-restart']);
    if (
      hasExactKeys(roles, ['checkpoint', 'keeper', 'zellijAlive', 'zellijExpected', 'shell', 'agent']) &&
      checkpoints.has(roles.checkpoint) && typeof roles.keeper === 'boolean' &&
      Number.isInteger(roles.zellijAlive) && Number.isInteger(roles.zellijExpected) &&
      roles.zellijAlive >= 0 && roles.zellijAlive <= roles.zellijExpected && roles.zellijExpected <= 8 &&
      typeof roles.shell === 'boolean' && typeof roles.agent === 'boolean'
    ) {
      failures.push(
        `s1:roles=${roles.checkpoint}/keeper:${Number(roles.keeper)}/zellij:${roles.zellijAlive}of${roles.zellijExpected}/shell:${Number(roles.shell)}/agent:${Number(roles.agent)}`,
      );
    }
  } catch (error) {
    if (!ignorableDiagnosticError(error)) throw error;
  }
  const recoveryPath = join(root, 's2', 'recovery-startup-failure.json');
  try {
    const recoveryResult = await readNoFollow(recoveryPath, 4096);
    scanPrivacy(recoveryResult.body);
    const recovery = JSON.parse(recoveryResult.body.toString('utf8'));
    const stages = new Set(['descriptor', 'launch', 'cgroup', 'readiness', 'notify']);
    const codes = new Set([
      'runtime_id', 'descriptor_schema', 'descriptor_runtime', 'descriptor_cwd',
      'descriptor_intent', 'descriptor_size', 'client_exit', 'cgroup_unified',
      'cgroup_unit', 'readiness_timeout', 'startup_failed',
    ]);
    if (hasExactKeys(recovery, ['stage', 'code']) && stages.has(recovery.stage) && codes.has(recovery.code)) {
      failures.push(`s2:recovery=${recovery.stage}/${recovery.code}`);
    }
  } catch (error) {
    if (!ignorableDiagnosticError(error)) throw error;
  }
  try {
    const memory = (await readNoFollow(join(root, 's1', 'memory-stage.txt'), 160)).body.toString('utf8').trim();
    const match = memory.match(/^(not_ready|limits_invalid|unit_no_pressure|slice_no_pressure)(?: unit=(\d{1,16}) slice=(\d{1,16}) current=(\d{1,16}) high=(\d{1,16}) hogs=(\d{1,3}))?$/);
    if (match) {
      const detail = match[2] ? `/unit:${match[2]}/slice:${match[3]}/current:${match[4]}/high:${match[5]}/hogs:${match[6]}` : '';
      failures.push(`s1:memory=${match[1]}${detail}`);
    }
  } catch (error) {
    if (!ignorableDiagnosticError(error)) throw error;
  }
  return failures;
}

function validateSummary(summary) {
  if (!hasExactKeys(summary, SUMMARY_KEYS) || summary.schemaVersion !== 1) fail('evidence_summary_schema');
  if (typeof summary.prHeadSha !== 'string' || !/^[0-9a-f]{40}$/.test(summary.prHeadSha)) {
    fail('evidence_summary_schema');
  }
  if (summary.zellijVersion !== 'zellij 0.44.1') fail('evidence_zellij_version');
  for (const field of ['ubuntuVersion', 'systemdVersion', 'kernelVersion']) {
    if (!isBoundedText(summary[field], 128)) fail('evidence_summary_schema');
  }
  validateGate(summary.s1, REQUIRED_S1_CHECKS);
  validateGate(summary.s2, REQUIRED_S2_CHECKS);
  if (
    !hasExactKeys(summary.privacyScan, ['status', 'findings']) ||
    summary.privacyScan.status !== 'pass' ||
    summary.privacyScan.findings !== 0
  ) {
    fail('evidence_privacy');
  }
  if (!Array.isArray(summary.files) || summary.files.length === 0 || summary.files.length > MAX_EVIDENCE_FILES) {
    fail('evidence_file_count');
  }
  if (!Number.isSafeInteger(summary.totalBytes) || summary.totalBytes < 0 || summary.totalBytes > MAX_EVIDENCE_TOTAL_BYTES) {
    fail('evidence_total_size');
  }
}

export async function validateEvidenceDirectory(inputRoot) {
  const root = resolve(inputRoot);
  const summaryResult = await readNoFollow(join(root, 'summary.json'), MAX_EVIDENCE_FILE_BYTES);
  scanPrivacy(summaryResult.body);
  let summary;
  try {
    summary = JSON.parse(summaryResult.body.toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) fail('evidence_summary_json');
    throw error;
  }
  validateSummary(summary);

  const seen = [];
  let totalBytes = 0;
  for (const file of summary.files) {
    if (!hasExactKeys(file, ['path', 'bytes', 'sha256'])) fail('evidence_file_metadata');
    const relative = validateRelativePath(file.path);
    if (relative === 'summary.json' || seen.includes(relative)) fail('evidence_file_path');
    seen.push(relative);
    if (
      !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_EVIDENCE_FILE_BYTES ||
      typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)
    ) {
      fail('evidence_file_metadata');
    }
    const absolute = resolve(root, relative);
    if (!absolute.startsWith(`${root}${sep}`)) fail('evidence_file_path');
    const result = await readNoFollow(absolute, MAX_EVIDENCE_FILE_BYTES);
    scanPrivacy(result.body);
    const digest = createHash('sha256').update(result.body).digest('hex');
    if (result.stat.size !== file.bytes || digest !== file.sha256) fail('evidence_file_metadata');
    totalBytes += result.stat.size;
    if (totalBytes > MAX_EVIDENCE_TOTAL_BYTES) fail('evidence_total_size');
  }
  if (totalBytes !== summary.totalBytes) fail('evidence_file_metadata');

  const actualFiles = (await inventory(root)).sort();
  const expectedFiles = ['summary.json', ...seen].sort();
  if (
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((path, index) => path !== expectedFiles[index])
  ) {
    fail('evidence_unlisted_file');
  }

  return {
    prHeadSha: summary.prHeadSha,
    zellijVersion: summary.zellijVersion,
    s1: summary.s1,
    s2: summary.s2,
    fileCount: seen.length,
    totalBytes,
    summarySha256: createHash('sha256').update(summaryResult.body).digest('hex'),
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const root = process.argv[2];
  if (!root) {
    console.error('usage: verify-evidence.mjs <evidence-directory>');
    process.exitCode = 2;
  } else {
    try {
      if (process.argv[3] === '--report-gates') {
        const failures = await reportGateChecks(root);
        process.stdout.write(`${failures.join('\n')}${failures.length > 0 ? '\n' : ''}`);
      } else {
        const result = await validateEvidenceDirectory(root);
        process.stdout.write(`${JSON.stringify(result)}\n`);
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'evidence_validation_failed';
      console.error(code);
      process.exitCode = 1;
    }
  }
}
