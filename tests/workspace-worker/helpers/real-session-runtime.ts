/** Paid opt-in fixture: real gateway, dispatcher and Agent SDK; no injected spawn. */
import { randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, relative } from 'node:path';
import { ensureHome } from '@matrix-os/kernel';
import { createGateway } from '../../../packages/gateway/src/server.js';
import { createOwnerAnthropicKeySaver } from '../../../packages/gateway/src/ai-providers/owner-anthropic-key.js';
import { runChatJob } from '../../../packages/workspace-worker/runtime/sessions.mjs';
import { summarizeGatewayResult } from '../../../packages/workspace-worker/runtime/result.mjs';

const root = process.env.MATRIX_SESSION_TEST_ROOT;
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!root || !apiKey || !process.env.DATABASE_URL || !process.env.MATRIX_AUTH_TOKEN) throw new Error('Isolated fixture configuration required');
const home = join(root, 'home');
const checkpoint = join(root, 'checkpoint');
const sentinel = randomBytes(12).toString('hex');
let gateway: Awaited<ReturnType<typeof createGateway>> | undefined;
let credential: ReturnType<typeof createOwnerAnthropicKeySaver> | undefined;
const costs: Array<{ cost: number; tokensIn: number; tokensOut: number; model: string }> = [];

async function start() {
  ensureHome(home);
  credential = createOwnerAnthropicKeySaver({ homePath: home });
  await credential(apiKey!);
  const port = await new Promise<number>((resolvePort, reject) => {
    const reservation = createServer();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const address = reservation.address();
      if (!address || typeof address === 'string') { reservation.close(); reject(new Error('Test port unavailable')); return; }
      reservation.close(() => resolvePort(address.port));
    });
  });
  // GatewayConfig has no hostname override; unique port plus auth protects its listener.
  gateway = await createGateway({ homePath: home, port, model: 'claude-haiku-4-5', maxTurns: 1 });
  return async (path: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${process.env.MATRIX_AUTH_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60_000), redirect: 'error',
    });
    if (!response.ok) throw new Error('Actual gateway request failed');
    return response;
  };
}
async function stop() {
  await gateway?.close(); gateway = undefined;
  await credential?.revoke(); credential = undefined;
}
function record(result: { events: Array<{ type: string; data?: Record<string, unknown> }> }) {
  const value = result.events.findLast(event => event.type === 'result')?.data;
  if (!value || typeof value.cost !== 'number' || typeof value.tokensIn !== 'number' || typeof value.tokensOut !== 'number') throw new Error('Actual SDK usage missing');
  costs.push({ cost: value.cost, tokensIn: value.tokensIn, tokensOut: value.tokensOut, model: typeof value.model === 'string' ? value.model : 'claude-haiku-4-5' });
  if (costs.reduce((total, entry) => total + entry.cost, 0) >= 0.10) throw new Error('Isolated test exceeded its cost ceiling');
}
async function transcriptSummary(directory: string) {
  const files: Array<{ path: string; bytes: number }> = [];
  async function visit(current: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        if (files.length >= 100) throw new Error('Test transcript count exceeded');
        files.push({ path: relative(directory, path), bytes: (await stat(path)).size });
      }
    }
  }
  await visit(join(directory, '.claude', 'projects'));
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function containsCredential(directory: string): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && await containsCredential(path)) return true;
    if (entry.isFile() && (await readFile(path)).includes(apiKey!)) return true;
  }
  return false;
}
try {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const request = await start();
  const first = await runChatJob(home, { ownerId: 'user_local_resume', chatId: 'chat_continuity', type: 'chat', message: `For this continuity check, reply only with this exact token: ${sentinel}. Do not use tools.` }, request);
  record(first);
  if (summarizeGatewayResult(first).trim() !== sentinel) throw new Error('First gateway turn did not acknowledge token');
  await stop();
  const transcriptsBeforeRestore = await transcriptSummary(home);
  await cp(home, checkpoint, { recursive: true, filter: source => {
    const path = relative(home, source);
    return !['system/ai-providers/anthropic-key.json', '.claude.json', '.claude/.claude.json', '.claude/.credentials.json', '.claude/settings.json', '.claude/settings.local.json'].includes(path)
      && !path.startsWith('system/ai-providers/.matrix-anthropic-key-staging');
  } });
  const checkpointContainsCredential = await containsCredential(checkpoint);
  if (checkpointContainsCredential) throw new Error('Checkpoint contains an inference credential');
  await rm(home, { recursive: true, force: true });
  await cp(checkpoint, home, { recursive: true });
  const transcriptsAfterRestore = await transcriptSummary(home);
  if (JSON.stringify(transcriptsBeforeRestore) !== JSON.stringify(transcriptsAfterRestore)) throw new Error('Restored transcript metadata differs');
  const restoredRequest = await start();
  const secondPrompt = 'Reply only with the exact token from my previous message. Do not use tools.';
  if (secondPrompt.includes(sentinel)) throw new Error('Invalid recall test');
  const second = await runChatJob(home, { ownerId: 'user_local_resume', chatId: 'chat_continuity', type: 'chat', message: secondPrompt }, restoredRequest);
  record(second);
  const third = await runChatJob(home, { ownerId: 'user_local_resume', chatId: 'chat_separate', type: 'chat', message: 'Reply only with FRESH. Do not use tools.' }, restoredRequest);
  record(third);
  const evidence = {
    boundary: 'local gateway and SDK process; saved-home replacement at the same path',
    sameSessionAfterRestore: first.sessionId === second.sessionId,
    recalledSentinel: summarizeGatewayResult(second).includes(sentinel),
    distinctChatSession: third.sessionId !== first.sessionId,
    checkpointContainsCredential, transcriptsBeforeRestore, transcriptsAfterRestore, totalCostUsd: costs.reduce((sum, value) => sum + value.cost, 0), usage: costs,
    limits: 'Cloudflare container replacement and trusted control-plane association binding remain unverified',
  };
  await writeFile(join(root, 'result.json'), JSON.stringify(evidence), { flag: 'wx', mode: 0o600 });
} finally { await stop(); }
