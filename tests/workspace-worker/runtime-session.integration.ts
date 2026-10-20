import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { access, chmod, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const enabled = process.env.MATRIX_RUNTIME_SESSION_INTEGRATION === '1';
const databaseUrl = process.env.MATRIX_RUNTIME_SESSION_TEST_DATABASE_URL;
const apiKey = process.env.ANTHROPIC_API_KEY;
const helper = resolve('tests/workspace-worker/helpers/real-session-runtime.ts');

describe.skipIf(!enabled)('actual Matrix gateway SDK session restore (paid opt-in)', () => {
  it('resumes one Chat after saved-home replacement and isolates another Chat', async () => {
    await access(helper);
    if (!apiKey || !databaseUrl) throw new Error('Explicit isolated database and AI credentials required');
    const database = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)) throw new Error('Only disposable local PostgreSQL is permitted');
    if (database.searchParams.has('host') && !database.searchParams.get('host')!.startsWith('/')) throw new Error('Only local database sockets are permitted');
    const name = `workspace_resume_${randomUUID().replaceAll('-', '')}`;
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'matrix-real-session-'));
    await chmod(directory, 0o700);
    const admin = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, query_timeout: 10_000 });
    let created = false;
    let child: ReturnType<typeof spawn> | undefined;
    const log = await open(join(directory, 'runtime.log'), 'wx', 0o600);
    try {
      await admin.query(`CREATE DATABASE "${name}"`); created = true;
      database.pathname = `/${name}`;
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH, HOME: join(directory, 'home'), NODE_ENV: 'test',
        DATABASE_URL: database.toString(), ANTHROPIC_API_KEY: apiKey,
        MATRIX_SESSION_TEST_ROOT: directory, MATRIX_AUTH_TOKEN: randomUUID(),
        MATRIX_HOME: join(directory, 'home'),
      };
      child = spawn(process.execPath, ['--import=tsx', helper], {
        cwd: process.cwd(), env, detached: true, stdio: ['ignore', log.fd, log.fd],
      });
      await new Promise<void>((resolveExit, reject) => {
        const timer = setTimeout(() => {
          if (child?.pid) process.kill(-child.pid, 'SIGKILL');
          reject(new Error('Actual gateway session integration timed out'));
        }, 180_000);
        child!.once('error', () => { clearTimeout(timer); reject(new Error('Actual gateway test process unavailable')); });
        child!.once('exit', code => { clearTimeout(timer); code === 0 ? resolveExit() : reject(new Error('Actual gateway session integration failed')); });
      });
      const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
      console.info('[workspace-session-evidence]', JSON.stringify(result));
      expect(result).toMatchObject({ sameSessionAfterRestore: true, recalledSentinel: true, distinctChatSession: true, checkpointContainsCredential: false });
      expect(result.totalCostUsd).toBeLessThan(0.10);
    } catch (error) {
      const raw = await readFile(join(directory, 'runtime.log'), 'utf8');
      // Keep diagnostics coarse: provider output and credentials never enter CI logs.
      const code = raw.includes('ERR_MODULE_NOT_FOUND') ? 'dependency_missing'
        : raw.includes('Runtime session state unavailable') ? 'session_state_rejected'
        : raw.includes('Gateway request failed') ? 'gateway_request_failed' : 'runtime_or_assertion_failed';
      console.error('[workspace-session-isolated-diagnostic]', { code });
      throw error;
    } finally {
      if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
      await log.close();
      try { if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
      finally { await admin.end(); await rm(directory, { recursive: true, force: true }); }
    }
  }, 210_000);
});
