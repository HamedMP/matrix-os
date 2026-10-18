import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeSessions, runChatJob } from '../../packages/workspace-worker/runtime/sessions.mjs';
import { parseQueuedJob } from '../../packages/workspace-worker/src/bridge.js';

const idA = 'f46dd3a2-fb54-460c-883d-d8cce11f4fe3';
const idB = '326f3235-4e3d-48e6-898f-a7b522c531b7';
const roots: string[] = [];
async function fixture() { const home = await mkdtemp(join(await realpath(tmpdir()), 'matrix-session-')); roots.push(home); return home; }
const result = (sessionId = idA) => JSON.stringify({ events: [{ type: 'init', sessionId }, { type: 'result', data: { sessionId, result: 'Done' } }] });
const job = (chatId = 'chat_a') => ({ ownerId: 'user_a', type: 'chat', chatId, message: 'Hello' });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('private runtime Chat identity', () => {
  it.each(['_preview','-preview','a'.repeat(160)])('runs Chat for every canonical queued owner form: %s',async ownerId=>{
    const home=await fixture();
    const queued=parseQueuedJob({...job(),ownerId,jobId:'accepted_owner'});
    await runChatJob(home,queued,async()=>new Response(result()));
    expect(await createRuntimeSessions(home,ownerId).get('chat_a')).toBe(idA);
  });
  it.each(['a'.repeat(161),'owner.with.dot','owner:scope','../owner'])('rejects noncanonical session owner %s',async ownerId=>{
    expect(()=>createRuntimeSessions('/private/tmp',ownerId)).toThrow('Runtime session');
  });
  it('passes only server-associated session identity and persists before success', async () => {
    const home = await fixture(); const requests: unknown[] = [];
    const request = async (_path: string, body: unknown) => { requests.push(body); return new Response(result()); };
    await runChatJob(home, { ...job(), sessionId: idB }, request);
    expect(await createRuntimeSessions(home, 'user_a').get('chat_a')).toBe(idA);
    await runChatJob(home, job(), request);
    expect(requests).toEqual([{ text: 'Hello' }, { text: 'Hello', sessionId: idA }]);
    expect((await stat(join(home, '.matrix-runtime', 'sessions.json'))).mode & 0o777).toBe(0o600);
  });
  it('isolates Chats and survives replacement/restored home', async () => {
    const home = await fixture();
    await runChatJob(home, job(), async () => new Response(result()));
    const restored = await fixture(); await mkdir(join(restored, '.matrix-runtime'));
    await writeFile(join(restored, '.matrix-runtime', 'sessions.json'), await readFile(join(home, '.matrix-runtime', 'sessions.json')));
    const calls: unknown[] = [];
    await runChatJob(restored, job('chat_b'), async (_path: string, body: unknown) => { calls.push(body); return new Response(result(idB)); });
    expect(calls).toEqual([{ text: 'Hello' }]);
    expect(await createRuntimeSessions(restored, 'user_a').get('chat_a')).toBe(idA);
    expect(await createRuntimeSessions(restored, 'user_a').get('chat_b')).toBe(idB);
  });
  it('rejects owner mismatch and corrupt state before invoking the gateway', async () => {
    const home = await fixture(); await createRuntimeSessions(home, 'user_a').bind('chat_a', idA);
    await expect(createRuntimeSessions(home, 'user_b').get('chat_a')).rejects.toThrow('Runtime session');
    await writeFile(join(home, '.matrix-runtime', 'sessions.json'), '{');
    let called = false;
    await expect(runChatJob(home, job(), async () => { called = true; return new Response(result()); })).rejects.toThrow('Runtime session');
    expect(called).toBe(false);
  });
  it('rejects invalid IDs and duplicate session ownership', async () => {
    const home = await fixture(); const store = createRuntimeSessions(home, 'user_a');
    await expect(store.bind('../escape', idA)).rejects.toThrow('Runtime session');
    await expect(store.bind('chat_a', '../escape')).rejects.toThrow('Runtime session');
    await store.bind('chat_a', idA);
    await expect(store.bind('chat_b', idA)).rejects.toThrow('Runtime session');
    await expect(store.bind('chat_a', idB)).rejects.toThrow('Runtime session');
  });
  it.each(['directory', 'file', 'ancestor'])('rejects a symlink at %s', async kind => {
    const home = await fixture(); const external = await fixture();
    if (kind === 'directory') await symlink(external, join(home, '.matrix-runtime'));
    else if (kind === 'ancestor') { const linked = join(home, 'linked'); await symlink(external, linked); await expect(createRuntimeSessions(linked, 'user_a').get('chat_a')).rejects.toThrow('Runtime session'); return; }
    else { await mkdir(join(home, '.matrix-runtime')); await writeFile(join(external, 'state'), '{}'); await symlink(join(external, 'state'), join(home, '.matrix-runtime', 'sessions.json')); }
    await expect(createRuntimeSessions(home, 'user_a').get('chat_a')).rejects.toThrow('Runtime session');
  });
  it('rejects oversized state and bounded history without forgetting earlier Chats', async () => {
    const home = await fixture(); await mkdir(join(home, '.matrix-runtime'));
    const file = join(home, '.matrix-runtime', 'sessions.json');
    await writeFile(file, 'x'.repeat(262145));
    await expect(createRuntimeSessions(home, 'user_a').get('chat_a')).rejects.toThrow('Runtime session');
    const sessions = Array.from({ length: 1000 }, (_, index) => ({ chatId: `chat_${index}`, sessionId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}` }));
    await writeFile(file, JSON.stringify({ version: 1, ownerId: 'user_a', sessions }));
    await expect(createRuntimeSessions(home, 'user_a').bind('chat_new', idA)).rejects.toThrow('Runtime session');
    expect(await createRuntimeSessions(home, 'user_a').get('chat_0')).toBe(sessions[0].sessionId);
  });
  it('rejects secret or unknown fields and duplicate associations in restored state', async () => {
    const home = await fixture(); await mkdir(join(home, '.matrix-runtime'));
    const file = join(home, '.matrix-runtime', 'sessions.json');
    for (const state of [
      { version: 1, ownerId: 'user_a', sessions: [], token: 'not-persisted' },
      { version: 1, ownerId: 'user_a', sessions: [{ chatId: 'chat_a', sessionId: idA }, { chatId: 'chat_b', sessionId: idA }] },
      { version: 1, ownerId: 'user_a', sessions: [{ chatId: 'chat_a', sessionId: idA }, { chatId: 'chat_a', sessionId: idB }] },
    ]) {
      await writeFile(file, JSON.stringify(state));
      await expect(createRuntimeSessions(home, 'user_a').get('chat_a')).rejects.toThrow('Runtime session');
    }
  });
  it('rejects association mutation while the gateway is running', async () => {
    const home = await fixture(); await createRuntimeSessions(home, 'user_a').bind('chat_a', idA);
    await expect(runChatJob(home, job(), async () => {
      await writeFile(join(home, '.matrix-runtime', 'sessions.json'), JSON.stringify({ version: 1, ownerId: 'user_a', sessions: [] }));
      return new Response(result());
    })).rejects.toThrow('Runtime session');
  });
  it('rejects failed or oversized response streams before binding a new session', async () => {
    const home = await fixture();
    const responses = [
      () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('Stream stopped')); } })),
      () => new Response('x'.repeat(256001)),
      () => new Response(null),
    ];
    for (const response of responses) {
      await expect(runChatJob(home, job(), async () => response())).rejects.toThrow();
      expect(await createRuntimeSessions(home, 'user_a').get('chat_a')).toBeUndefined();
    }
  });
  it.each(['truncated', 'error', 'conflict', 'changed'])('does not save identity or output after %s execution', async failure => {
    const home = await fixture(); await createRuntimeSessions(home, 'user_a').bind('chat_a', idA);
    const response = failure === 'truncated' ? '{' : failure === 'error' ? JSON.stringify({ events: [{ type: 'error' }, { type: 'result', data: { sessionId: idA, result: 'Done' } }] }) : failure === 'conflict' ? JSON.stringify({ events: [{ type: 'init', sessionId: idA }, { type: 'result', data: { sessionId: idB, result: 'Done' } }] }) : result(idB);
    await expect(runChatJob(home, job(), async () => new Response(response))).rejects.toThrow();
    expect(await createRuntimeSessions(home, 'user_a').get('chat_a')).toBe(idA);
  });
});
