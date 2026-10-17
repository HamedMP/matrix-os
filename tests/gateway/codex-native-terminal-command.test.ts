import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { codexNativeTerminalCommand } from '../../packages/gateway/src/ai-providers/codex-native-terminal-command.js';
const execute = promisify(execFile);
it.each(['signed-out', 'chatgpt', 'key', 'error'] as const)('uses owner CLI without replacing credentials for %s', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'codex-terminal-fixture-'));
  try {
    await mkdir(join(root, 'bin'));
    const cli = join(root, 'bin/codex');
    const status = mode === 'signed-out' ? 'Not logged in' : mode === 'chatgpt' ? 'Logged in using ChatGPT' : mode === 'key' ? 'Logged in using an API key' : 'unavailable';
    await writeFile(cli, `#!/bin/sh\nif [ "$2" = status ]; then echo '${status}' >&2; exit ${mode === 'signed-out' || mode === 'error' ? 1 : 0}; fi\n[ -z "$OPENAI_API_KEY" ] || exit 9\n[ "$HOME" = '${root}' ] || exit 8\nprintf '%s' "$*" > '${root}/called'\n`);
    await chmod(cli, 0o700);
    const command = codexNativeTerminalCommand(root, { executable: cli, environment: { HOME: root, MATRIX_HOME: root, MATRIX_NODE_PREFIX: root, PATH: process.env.PATH! } });
    const run = execute('sh', ['-c', command], { env: { ...process.env, OPENAI_API_KEY: 'synthetic-parent-key', CODEX_HOME: '/foreign' }, timeout: 5000 });
    if (mode === 'key' || mode === 'error') await expect(run).rejects.toBeDefined(); else await run;
    if (mode === 'signed-out') expect(await readFile(join(root, 'called'), 'utf8')).toBe('login --device-auth');
    else await expect(readFile(join(root, 'called'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('cleans the wrapper environment before Node can execute parent preloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-wrapper-fixture-'));
  try {
    const cli = join(root, 'codex');
    const injected = join(root, 'injected');
    const preload = join(root, 'preload.cjs');
    await writeFile(preload, `require('node:fs').writeFileSync(${JSON.stringify(injected)}, 'preload executed');`);
    await writeFile(cli, '#!/bin/sh\n[ "$2" = status ] && { echo "Logged in using ChatGPT"; exit 0; }\nexit 1\n');
    await chmod(cli, 0o700);
    const command = codexNativeTerminalCommand(root, { executable: cli, environment: { PATH: process.env.PATH! } });
    await execute('sh', ['-c', command], {
      env: { ...process.env, NODE_OPTIONS: `--require=${preload}` }, timeout: 5000,
    });
    await expect(readFile(injected, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
