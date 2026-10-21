import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { dependencyPlan, verifyDependencyBytes } from '../../../packages/gateway/src/app-store/dependency-broker.js';
const bytes = Buffer.from('tarball');
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const lock = (resolution: unknown = { integrity }) => JSON.stringify({ lockfileVersion: '9.0', importers: { '.': { dependencies: { react: { specifier: '19.2.0', version: '19.2.0' } } } }, packages: { 'react@19.2.0': { resolution } }, snapshots: { 'react@19.2.0': {} } });
describe('registry dependency broker', () => {
  it('derives only official registry URLs and rewrites to verified offline files', () => {
    const plan = dependencyPlan(lock());
    expect(plan.dependencies[0].url).toBe('https://registry.npmjs.org/react/-/react-19.2.0.tgz');
    expect(plan.lockfile).toContain('file:/deps/');
    expect(plan.lockfile).not.toContain('https://');
    expect(verifyDependencyBytes(plan.dependencies[0], bytes)).toBe(true);
    expect(verifyDependencyBytes(plan.dependencies[0], Buffer.from('forged'))).toBe(false);
  });
  it.each([{ integrity, tarball: 'https://evil.test/a' }, { integrity, type: 'directory' }, { integrity: 'sha1-weak' }])('rejects arbitrary resolutions %o', resolution => {
    expect(() => dependencyPlan(lock(resolution))).toThrow();
  });
  it('rejects workspace importers and malformed lockfiles', () => {
    expect(() => dependencyPlan('a: &a [*a]')).toThrow();
    expect(() => dependencyPlan(lock().replace('react@19.2.0', '../escape@1.0.0'))).toThrow();
    expect(() => dependencyPlan(JSON.stringify({lockfileVersion:'9.0',importers:{'.':{},'../private':{}},packages:{}}))).toThrow();
  });
});
