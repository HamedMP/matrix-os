import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildScopeCodexExecLaunch, parseScopeCodexJsonEvents, SCOPE_RUNTIME_CODEX_HARNESS_VERSION } from '../../packages/scope-runtime/src/worker.js';

// Explicit qualification lane: install the exact published CLI, then set this
// path. No normal test may borrow an authenticated Codex from the user's PATH.
const binary = process.env.CODEX_CONTRACT_BINARY;
describe.runIf(Boolean(binary))('published scope Codex contract (no paid inference)', () => {
  it('accepts the real strict config and sends no tools, credentials or stored Responses', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scope-codex-published-'));
    const requests: Array<Record<string, unknown>> = [];
    const authorizations: Array<string | undefined> = [];
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(`${req.method} ${req.url}`);
      let bytes = '';
      req.on('data', chunk => {
        bytes += chunk;
        if (Buffer.byteLength(bytes) > 1024 * 1024) req.destroy();
      });
      req.on('end', () => {
        if (req.url !== '/v1/responses') { res.writeHead(404).end(); return; }
        authorizations.push(req.headers.authorization);
        requests.push(JSON.parse(bytes));
        const item = { type: 'message', id: 'msg_scope_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Scope fixture answer', annotations: [] }] };
        const events = [
          { type: 'response.created', response: { id: 'resp_scope_fixture', status: 'in_progress' } },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id: 'resp_scope_fixture', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
    const launch = buildScopeCodexExecLaunch({ bridgePort: address.port, model: 'gpt-5.6-sol', prompt: 'Return the fixture answer.' });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const version = await new Promise<string>((resolve, reject) => {
        const probe = spawn(binary!, ['--version'], { env: { HOME: home, PATH: launch.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = ''; probe.stdout.on('data', chunk => { output += chunk; });
        probe.once('error', reject); probe.once('close', code => code === 0 ? resolve(output.trim()) : reject(new Error('Version probe failed')));
      });
      expect(version).toBe(`codex-cli ${SCOPE_RUNTIME_CODEX_HARNESS_VERSION}`);
      // Keep the synthetic loopback provider out of macOS system proxy fallback.
      child = spawn(binary!, launch.args, { cwd: home, env: { ...launch.env, HOME: home, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout!.on('data', chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 1024 * 1024) child?.kill(); });
      child.stderr!.on('data', chunk => { stderr += chunk; if (Buffer.byteLength(stderr) > 1024 * 1024) child?.kill(); });
      const timer = setTimeout(() => child?.kill('SIGKILL'), 12_000);
      let code: number | null;
      try { code = await new Promise<number | null>((resolve, reject) => { child!.once('error', reject); child!.once('close', resolve); }); }
      finally { clearTimeout(timer); }
      expect(code, `${stderr}\n${stdout}\nrequests=${requests.length} paths=${JSON.stringify(paths)}`).toBe(0);
      expect(parseScopeCodexJsonEvents(stdout.trim().split('\n'))).toBe('Scope fixture answer');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.store).toBe(false);
      expect(requests[0]?.tools ?? []).toEqual([]);
      expect(authorizations).toEqual([undefined]);
    } finally {
      if (child?.exitCode === null) child.kill('SIGKILL');
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  }, 20_000);
});
