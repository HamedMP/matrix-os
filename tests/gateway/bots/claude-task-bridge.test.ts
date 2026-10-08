import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { openClaudeBotBridge } from '../../../packages/gateway/src/bots/claude-task-bridge.js';
import { qualifiesClaudeBotRuntime } from '../../../packages/gateway/src/bots/claude-task-observation.js';
const runner = fileURLToPath(new URL('../../../packages/gateway/src/coding-agents/bot-task-mcp-runner.mjs', import.meta.url));
describe('bounded native task MCP protocol', () => {
  it('requires the installed restricted and noninteractive permission protocol', () => {
    const help = '--restricted --tools --strict-mcp-config --setting-sources --output-format --permission-prompts';
    expect(qualifiesClaudeBotRuntime('2.1.280 (Claude Code)', help)).toBe(true);
    expect(qualifiesClaudeBotRuntime('2.1.258 (Claude Code)', help)).toBe(false);
    expect(qualifiesClaudeBotRuntime('2.1.280 (Claude Code)', help.replace('--permission-prompts', ''))).toBe(false);
  });
  it('serves actual stdio MCP only through a child-specific bearer and exact Bot capabilities', async () => {
    const call = vi.fn(async () => ({ ok: true as const, content: [{ type: 'text' as const, text: 'owner artifact' }] })); const authorize = vi.fn(async () => undefined);
    const bridge = await openClaudeBotBridge({ capabilities: ['artifact.read', 'agent.task'], signal: new AbortController().signal, authorize, call });
    const child = spawn(process.execPath, [runner], { env: { PATH: process.env.PATH, MATRIX_BOT_TASK_URL: bridge.url, MATRIX_BOT_TASK_TOKEN: bridge.token }, stdio: ['pipe', 'pipe', 'pipe'] });
    const exit = once(child, 'exit'); let output = ''; child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
    try {
      expect((await fetch(bridge.url, { method: 'POST', body: '{}', signal: AbortSignal.timeout(5000) })).status).toBe(403);
      for (const frame of [{ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, { id: 2, method: 'tools/list' }, { id: 3, method: 'tools/call', params: { name: 'call', arguments: { capability: 'artifact.read', args: { relPath: 'draft.txt' } } } }]) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
      await vi.waitFor(() => expect(output.split('\n').filter(Boolean)).toHaveLength(3));
      const frames = output.trim().split('\n').map(line => JSON.parse(line)); expect(frames[1].result.tools[0].inputSchema.properties.capability.enum).toEqual(['artifact.read']);
      expect(frames[2].result.content[0].text).toBe('owner artifact'); expect(call).toHaveBeenCalledWith(expect.objectContaining({ capability: 'artifact.read', toolCallId: expect.stringMatching(/^native_/) })); expect(authorize).toHaveBeenCalledTimes(2);
      child.stdin.end(); expect((await exit)[0]).toBe(0);
    } finally { child.kill('SIGKILL'); await bridge.close(); }
  });
  it('rejects an unterminated oversized stdin frame before buffering an unbounded line', async () => {
    const child = spawn(process.execPath, [runner], { env: { MATRIX_BOT_TASK_URL: 'http://127.0.0.1:12345', MATRIX_BOT_TASK_TOKEN: 'f'.repeat(64) }, stdio: ['pipe', 'pipe', 'pipe'] });
    const exit = once(child, 'exit'); child.stdin.on('error', () => undefined); child.stdin.write('x'.repeat(241 * 1024)); child.stdin.end();
    expect((await exit)[0]).toBe(1);
  });
});
