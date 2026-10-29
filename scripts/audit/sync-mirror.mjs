#!/usr/bin/env node
// Temporary source/dependency mirror. Never execute or check out mirrored code.
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'HamedMP/matrix-os';
const DESTINATION = 'FinnaAI/matrix-os';
const SHA = /^[0-9a-f]{40}$/;

function git(cwd, env, args, allowed = [0]) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, env, encoding: 'utf8', timeout: 240_000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Git diagnostics may contain authentication material; never print raw stderr.
  if (result.error || !allowed.includes(result.status)) throw new Error(`Git operation failed: ${args[0]}`);
  return { text: result.stdout.trim(), status: result.status };
}

export function assertMirrorMetadata(repository, permissions) {
  if (repository?.full_name !== DESTINATION || repository.visibility !== 'public' ||
      repository.private !== false || repository.archived !== false || repository.disabled !== false ||
      repository.default_branch !== 'main' || permissions?.enabled !== false) {
    throw new Error('Mirror policy failed: require the public active FinnaAI/matrix-os main with Actions disabled');
  }
}

export async function syncMain({ source, destination, assertSafe, env = process.env }) {
  if (typeof assertSafe !== 'function') throw new Error('A destination policy check is required');
  const directory = await mkdtemp(join(tmpdir(), 'matrix-audit-sync-'));
  const gitEnv = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const run = (args, allowed) => git(directory, gitEnv, args, allowed);
  try {
    await assertSafe();
    run(['init', '--bare', '--template=']);
    run(['fetch', '--no-tags', source, 'refs/heads/main:refs/heads/source']);
    run(['fetch', '--no-tags', destination, 'refs/heads/main:refs/heads/destination']);
    const previous = run(['rev-parse', 'refs/heads/destination']).text;
    // A second non-forcing fetch rejects source rewrites observed during this run.
    run(['fetch', '--no-tags', source, 'refs/heads/main:refs/heads/source']);
    const current = run(['rev-parse', 'refs/heads/source']).text;
    if (!SHA.test(previous) || !SHA.test(current)) throw new Error('Invalid main commit');
    if (run(['merge-base', '--is-ancestor', previous, current], [0, 1]).status !== 0) {
      throw new Error('Mirror diverged or source main was rewritten; manual investigation required');
    }
    await assertSafe();
    const observed = run(['ls-remote', '--exit-code', destination, 'refs/heads/main']).text.split(/\s+/)[0];
    if (observed !== previous) throw new Error('Mirror changed concurrently; retry after investigation');
    if (current !== previous) {
      // Deliberately no --mirror, --all, tags, '+' refspec, force or lease override.
      run(['push', destination, `${current}:refs/heads/main`]);
    }
    const verified = run(['ls-remote', '--exit-code', destination, 'refs/heads/main']).text.split(/\s+/)[0];
    if (verified !== current) throw new Error('Mirror equality verification failed');
    await assertSafe();
    return { source: current, previous, changed: current !== previous };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function readGitHub(path, token, fetcher = fetch) {
  const response = await fetcher(`https://api.github.com/repos/${DESTINATION}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(10_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Mirror API check failed: HTTP ${response.status}`);
  return response.json();
}

async function main() {
  if (process.env.GITHUB_REPOSITORY !== SOURCE || process.env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Run this controller only from HamedMP/matrix-os main');
  }
  const token = process.env.MATRIX_AUDIT_MIRROR_TOKEN;
  if (!token) throw new Error('Missing narrowly scoped mirror GitHub App token');
  const directory = await mkdtemp(join(tmpdir(), 'matrix-audit-auth-'));
  try {
    const askpass = join(directory, 'askpass.sh');
    await writeFile(askpass, '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" x-access-token ;;\n  *Password*) printf "%s\\n" "$MATRIX_AUDIT_MIRROR_TOKEN" ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o700 });
    const assertSafe = async () => {
      const repository = await readGitHub('', token);
      const permissions = await readGitHub('/actions/permissions', token);
      assertMirrorMetadata(repository, permissions);
    };
    const receipt = await syncMain({
      source: `https://github.com/${SOURCE}.git`, destination: `https://github.com/${DESTINATION}.git`,
      assertSafe, env: { ...process.env, GIT_ASKPASS: askpass },
    });
    console.log(JSON.stringify({ ...receipt, destination: DESTINATION, actionsEnabled: false }));
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY,
        `### Audit source mirror\n\nSource main: \`${receipt.source}\`\n\nMirror verified equal; Actions disabled. Changed: ${receipt.changed}.\n\nSource/dependency evidence only; upstream PR review, CI and access evidence remain separate.\n`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : 'Mirror synchronization failed'); process.exitCode = 1; });
}
