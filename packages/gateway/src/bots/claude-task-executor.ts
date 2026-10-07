import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import type { CanonicalCliSpawn, CanonicalCliProcess } from '../chat/cli-process.js';
import { spawnIsolatedProviderProcess } from '../coding-agents/provider-process-isolation.js';
import { sanitizeAssistantText } from '../chat/safe-activity-projection.js';

interface NativeTaskProcess extends CanonicalCliProcess {
  pid?: number;
  once(event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
}
type NativeTaskSpawn = (...args: Parameters<CanonicalCliSpawn>) => NativeTaskProcess;
const runner = fileURLToPath(new URL('../coding-agents/bot-task-mcp-runner.mjs', import.meta.url));
/** Retain native HOME auth while excluding ambient Matrix/API credentials and configuration overrides. */
export function claudeBotEnvironment(homePath: string): Record<string, string> {
  return { HOME: homePath, PATH: `${process.env.MATRIX_NODE_PREFIX ?? '/opt/matrix/runtime/node'}/bin:${process.env.PATH ?? '/usr/bin:/bin'}`,
    LANG: 'C.UTF-8', TERM: 'dumb' };
}
/** Official CLI only. No SDK credentials, inner-loop substitution or guessed completed result. */
export async function runClaudeBotTask(input: {
  command: string; homePath: string; cwd: string; model: string; prompt: string; sessionId?: string;
  signal: AbortSignal; mcpUrl: string; mcpToken: string; spawn?: NativeTaskSpawn;
}): Promise<{ text: string; sessionId: string }> {
  input.signal.throwIfAborted();
  const args = ['--print', '--verbose', '--output-format', 'stream-json', '--restricted', '--tools', '', '--setting-sources', '',
    '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { matrix_bot: { command: process.execPath, args: [runner] } } }),
    '--allowedTools', 'mcp__matrix_bot__call', '--permission-prompts', 'none', '--model', input.model, ...(input.sessionId ? ['--resume', input.sessionId] : [])];
  const spawn: NativeTaskSpawn = input.spawn ?? spawnIsolatedProviderProcess;
  const child = spawn(input.command, args, { cwd: input.cwd,
    env: { ...claudeBotEnvironment(input.homePath), MATRIX_BOT_TASK_URL: input.mcpUrl, MATRIX_BOT_TASK_TOKEN: input.mcpToken }, stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let buffer = ''; let bytes = 0; let result: { text: string; sessionId: string } | undefined;
    let exited = false; let stopped = false; let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { if (stopped) return; stopped = true; if (exited) return; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); killTimer.unref(); };
    const cleanup = () => { input.signal.removeEventListener('abort', stop); if (killTimer) clearTimeout(killTimer); };
    const fail = () => new Error('Native task did not complete');
    // close follows actual exit and stdio EOF; exit alone can precede the final stdout bytes.
    child.once('exit', () => { exited = true; if (killTimer) clearTimeout(killTimer); });
    child.once('close', (code) => { cleanup(); if (!stopped && code === 0 && result && !(buffer + decoder.end()).trim()) resolve(result); else reject(fail()); });
    child.once('error', (error) => {
      if (!('pid' in child && typeof child.pid === 'number') && error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EACCES')) { cleanup(); reject(fail()); }
      else stop();
    });
    child.stdout.on('data', chunk => {
      if (stopped) return;
      bytes += chunk.byteLength;
      if (bytes > 2 * 1024 * 1024) { stop(); return; }
      buffer += decoder.write(chunk);
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === 'result') {
            if (event.subtype !== 'success' || event.is_error !== false || typeof event.result !== 'string'
              || typeof event.session_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(event.session_id)) { stop(); return; }
            const text = sanitizeAssistantText(event.result, { homePath: input.homePath, executionRoot: input.cwd });
            if (!text || Buffer.byteLength(text) > 60 * 1024) { stop(); return; }
            result = { text, sessionId: event.session_id };
          }
        } catch (error) { if (error instanceof SyntaxError) stop(); else { console.warn('[bot-native] Invalid result:', error instanceof Error ? error.name : 'UnknownError'); stop(); } }
      }
    });
    let stderrBytes = 0;
    child.stderr.on('data', chunk => { stderrBytes += chunk.byteLength; if (stderrBytes > 64 * 1024) stop(); });
    input.signal.addEventListener('abort', stop, { once: true });
    child.stdin?.on?.('error', stop);
    try {
      if (!child.stdin) stop();
      else { child.stdin.write(input.prompt); child.stdin.end?.(); }
    } catch (error) {
      // A pipe exception is not evidence that the native child exited. Keep
      // the promise (and caller's durable lease) pending until actual close.
      console.warn('[bot-native] Prompt delivery failed:', error instanceof Error ? error.name : 'UnknownError');
      stop();
    }
    if (input.signal.aborted) stop();
  });
}
