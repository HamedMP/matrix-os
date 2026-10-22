import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

it.each(['desktop', 'unit'])('passes verified checkout provenance to the actual %s child despite runner-owned SHA', kind => {
  const fixture = mkdtempSync(join(tmpdir(), 'matrix-ci-child-source-'));
  try {
    const root = join(fixture, 'source'); const bin = join(fixture, 'bin');
    mkdirSync(root); mkdirSync(bin);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000, stdio: 'pipe' }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
    const commit = (text: string) => { writeFileSync(join(root, 'source.txt'), text); git('add', 'source.txt'); git('commit', '-m', text); return git('rev-parse', 'HEAD'); };
    const controller = commit('controller'); const source = commit('verified checkout');
    const script = join(fixture, 'child.mjs');
    writeFileSync(script, `import {readBuildSource} from ${JSON.stringify(pathToFileURL(resolve('scripts/release/build-source.mjs')).href)}; console.log(JSON.stringify(readBuildSource(process.cwd(), process.env.GITHUB_SHA)));`);
    const bun = join(bin, 'bun');
    writeFileSync(bun, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}\n`); chmodSync(bun, 0o755);
    const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
    const step = kind === 'desktop' ? workflow.jobs.e2e.steps.find((s: {name?: string}) => s.name === 'Build Desktop for Electron E2E') : workflow.jobs.unit.steps.find((s: {run?: string}) => s.run?.includes('bun run test -- --shard='));
    // The runner imposes reserved defaults after workflow environment values.
    const env = { ...process.env, ...Object.fromEntries(Object.keys(step.env).map(key => [key, source])), PATH: `${bin}:${process.env.PATH}`, GITHUB_SHA: controller };
    const control = spawnSync(bun, [], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
    expect(control.status).not.toBe(0); expect(control.stderr).toContain('Release commit does not match');
    const child = spawnSync('sh', ['-c', step.run.replaceAll('${{ matrix.shard }}', '1')], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ commit: source, ancestors: [controller] });
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
