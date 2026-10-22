// Qualification executes parity in the full unit collection exactly once.
// This read-only guard proves coverage; it never evaluates report content.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const MAX_REPORT_FILES = 10000;
const MAX_FILE_ASSERTIONS = 100000;
const required = Object.freeze([
  ['tests/repository/site-extraction.test.ts', 2],
  ['tests/contracts/os-view.test.ts', 12],
  ['tests/shell/desktop-mode-parity.test.ts', 3],
  ['tests/shell/desktop-launcher-mode.test.tsx', 21],
  ['tests/shell/web-desktop-surface.test.tsx', 10],
  ['tests/shell/os-view-state-client.test.ts', 6],
  ['tests/desktop/app-launcher.test.tsx', 13],
  ['tests/desktop/native-desktop-shell.test.tsx', 47],
  ['tests/desktop/os-view-state-client.test.ts', 4],
  ['tests/desktop/native-os-view-persistence.test.ts', 4],
  ['tests/gateway/os-view-state-repository.test.ts', 12],
]);

export async function readQualificationCoverage(path) {
  // NOFOLLOW rejects leaf symlinks; NONBLOCK prevents a named pipe from hanging
  // before the descriptor's regular-file and size checks can reject it.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_REPORT_BYTES) throw new Error('Qualification report exceeds its regular-file size limit');
    const buffer = Buffer.alloc(MAX_REPORT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_REPORT_BYTES) throw new Error('Qualification report exceeds its size limit');
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally { await handle.close(); }
}

export function validateQualificationCoverage(report, root = process.cwd()) {
  if (!report || report.success !== true || report.numFailedTests !== 0 ||
      (report.numFailedTestSuites !== undefined && report.numFailedTestSuites !== 0) ||
      !Array.isArray(report.testResults) || report.testResults.length > MAX_REPORT_FILES) {
    throw new Error('Qualification requires a complete successful bounded unit report');
  }
  let assertions = 0;
  for (const [path, minimum] of required) {
    const absolute = resolve(root, path);
    const matches = report.testResults.filter(result => result?.name === path || result?.name === absolute);
    if (matches.length !== 1) throw new Error(`Qualification requires exactly one result for ${path}`);
    const result = matches[0];
    if (result.status !== 'passed' || !Array.isArray(result.assertionResults) ||
        result.assertionResults.length < minimum || result.assertionResults.length > MAX_FILE_ASSERTIONS ||
        !result.assertionResults.every(assertion => assertion?.status === 'passed')) {
      throw new Error(`Qualification requires every assertion passed for ${path}`);
    }
    assertions += result.assertionResults.length;
  }
  return { files: required.length, assertions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('One unit report path is required');
    const result = validateQualificationCoverage(await readQualificationCoverage(process.argv[2]));
    console.log(`Qualification parity verified: ${result.files} files, ${result.assertions} passed assertions`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Qualification coverage verification failed');
    process.exitCode = 1;
  }
}
