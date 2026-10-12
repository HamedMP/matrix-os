import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { readQualificationCoverage, validateQualificationCoverage } from '../../scripts/ci/qualification-coverage.mjs';

const root = '/work/repo';
const required = [
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
] as const;
function fixture() {
  return { success: true, numFailedTests: 0, testResults: required.map(([path, count]) => ({
    name: `${root}/${path}`, status: 'passed', assertionResults: Array.from({ length: count }, () => ({ status: 'passed' })),
  })) };
}
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function file(content: string) {
  const directory = await mkdtemp(join(tmpdir(), 'matrix-qualification-coverage-')); directories.push(directory);
  const path = join(directory, 'unit.json'); await writeFile(path, content); return path;
}

describe('unit-collected qualification parity evidence', () => {
  it('proves every required file and all 134 passed assertions, allowing additional passed cases', () => {
    const report = fixture();
    expect(validateQualificationCoverage(report, root)).toEqual({ files: 11, assertions: 134 });
    report.testResults[0].assertionResults.push({ status: 'passed' });
    expect(validateQualificationCoverage(report, root)).toEqual({ files: 11, assertions: 135 });
  });
  it.each(required)('requires %s to be present', path => {
    const report = fixture(); report.testResults = report.testResults.filter(value => value.name !== `${root}/${path}`);
    expect(() => validateQualificationCoverage(report, root)).toThrow();
  });
  it.each(['pending', 'skipped', 'failed', 'todo'])('rejects any %s assertion', status => {
    const report = fixture(); report.testResults[0].assertionResults[0].status = status;
    expect(() => validateQualificationCoverage(report, root)).toThrow();
  });
  it.each(['success', 'failure', 'pending'])('requires the file status to be passed, rejecting %s', status => {
    const report = fixture(); report.testResults[0].status = status;
    expect(() => validateQualificationCoverage(report, root)).toThrow();
  });
  it('rejects duplicate results and counts below each recorded minimum', () => {
    for (let index = 0; index < required.length; index++) {
      const duplicate = fixture(); duplicate.testResults.push(duplicate.testResults[index]);
      expect(() => validateQualificationCoverage(duplicate, root)).toThrow();
      const reduced = fixture(); reduced.testResults[index].assertionResults.pop();
      expect(() => validateQualificationCoverage(reduced, root)).toThrow();
    }
  });
  it('does not accept a suffix-matching file from a different checkout', () => {
    const report = fixture(); report.testResults[0].name = '/other/repo/' + required[0][0];
    expect(() => validateQualificationCoverage(report, root)).toThrow();
  });
  it.each([null, {}, { success: false, numFailedTests: 0, testResults: [] }, { ...fixture(), numFailedTests: 1 }])('fails closed for malformed or unsuccessful evidence', report => {
    expect(() => validateQualificationCoverage(report, root)).toThrow();
  });
  it('reads only bounded regular JSON files', async () => {
    const path = await file(JSON.stringify(fixture()));
    expect(validateQualificationCoverage(await readQualificationCoverage(path), root).assertions).toBe(134);
    const linked = path + '.link'; await symlink(path, linked);
    await expect(readQualificationCoverage(linked)).rejects.toThrow();
    await expect(readQualificationCoverage(path + '.missing')).rejects.toThrow();
    await expect(readQualificationCoverage(await file('not json'))).rejects.toThrow();
    await expect(readQualificationCoverage(await file(' '.repeat(32 * 1024 * 1024 + 1)))).rejects.toThrow('limit');
  });
});
