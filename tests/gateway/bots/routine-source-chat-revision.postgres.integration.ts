// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CanonicalCreateChatTurnRequest } from '@matrix-os/contracts';
import { createRealBotStateDatabase, OWNER } from './bot-state-support';
import { proposalFixture } from './routine-cli-proposal-support';
import { terminalFixtureFire, originService } from './routine-chat-origin-support';
import { createCanonicalChatEventStream } from '../../../packages/gateway/src/chat/event-stream';
import type { CanonicalChatTransportFrame } from '@matrix-os/contracts';
import { scope } from './routine-cli-request-support';
import { useCanonicalChatState } from '../../../shell/src/hooks/useCanonicalChatState';
import { stubLegacyChatFetch } from '../../shell/legacy-navigation-fetch-fixture';

vi.mock('@/hooks/useSocket', () => ({ useSocket: () => ({ connected: true }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(['attachment', 'scope read'] as const)('uses the accepted source revision when a real routine result commits during awaited %s preparation', async preparation => {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
  if (!url) throw new Error('MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required');
  const data = await createRealBotStateDatabase(url), f = await proposalFixture(data.db, vi.fn);
  const owner = { type: 'personal' as const, ownerId: OWNER };
  const origin = originService(f), events = createCanonicalChatEventStream({ repository: f.chats });
  let releaseUpload!: () => void;
  const upload = new Promise<void>(resolve => { releaseUpload = resolve; });
  let uploading = false, wire: ReadableStreamDefaultController<Uint8Array> | undefined;
  const requests: CanonicalCreateChatTurnRequest[] = [];
  let hook: ReturnType<typeof renderHook<ReturnType<typeof useCanonicalChatState>, unknown>> | undefined;
  try {
    const fire = await terminalFixtureFire(f); await fire.finish();
    await f.chats.finishRun(owner, { chatId: 'chat_source', runId: 'run_source', outcome: 'completed', completedAt: f.state.clock });
    const detail = () => f.chats.getDetailPage(owner, 'chat_source', { limit: 200 });
    const before = (await detail())!;
    stubLegacyChatFetch(vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes('/events?')) {
        const body = new ReadableStream<Uint8Array>({ start(controller) { wire = controller; } });
        await events.open({ principal: { userId: OWNER, source: 'jwt' }, content: true,
          sink: { send(frame) { wire!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`)); return true; }, close() {} } });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (path.includes('/api/chats?')) return Response.json({ items: [(await detail())!.record] });
      if (path.includes('/api/chats/chat_source?')) return Response.json(await detail());
      if (path.includes('/routine-cli/full-access')) {
        if (preparation === 'scope read') { uploading = true; await upload; }
        return Response.json({ revision: 0, eligibility: 'eligible', origin: 'browser_required', consent: null, challenge: null });
      }
      if (path.includes('/api/files/blob?')) {
        uploading = true; await upload;
        return Response.json({ ok: true, path: new URL(path, 'http://fixture.test').searchParams.get('path'), size: 5 });
      }
      if (path.includes('/api/chats/chat_source/turns?')) {
        const input = JSON.parse(String(init?.body)) as CanonicalCreateChatTurnRequest; requests.push(input);
        const current = (await detail())!, templateRun = current.runs.find(run => run.id === 'run_source')!;
        const templateTurn = current.turns.find(turn => turn.id === templateRun.turnId)!;
        const templateMessage = current.messages.find(message => message.id === templateTurn.inputMessageId)!;
        try {
          const admitted = await f.chats.admitTurn(owner, { chatId: 'chat_source', baseRevision: input.baseRevision,
            message: { ...templateMessage, id: 'msg_next_owner', turnId: 'cturn_next_owner', seq: current.record.chat.messageCount + 1, parts: input.parts },
            turn: { ...templateTurn, id: 'cturn_next_owner', clientRequestId: input.clientRequestId, inputMessageId: 'msg_next_owner', baseMessageSeq: current.record.chat.messageCount, status: 'accepted' },
            run: { ...templateRun, id: 'run_next_owner', turnId: 'cturn_next_owner', status: 'accepted', outcome: undefined, completedAt: undefined,
              historyBoundarySeq: current.record.chat.messageCount, selection: input.selection } });
          return Response.json({ record: admitted.chat, message: admitted.message, turn: admitted.turn, run: admitted.run, admission: 'accepted' });
        } catch (error: unknown) {
          if (!(error instanceof Error)) throw error;
          return Response.json({ error: 'Conflict' }, { status: 409 });
        }
      }
      throw new Error('Unexpected revision seam request');
    }));
    hook = renderHook(() => useCanonicalChatState());
    await waitFor(() => expect(hook!.result.current.routineFullAccessChat).toMatchObject({ revision: before.record.chat.revision }));
    const selection = hook.result.current.providerSelection;
    act(() => hook!.result.current.requestComposerDraft('Unsent next owner draft'));
    let submitted!: Promise<boolean>;
    act(() => { submitted = Promise.resolve(hook!.result.current.submitMessage('Next owner request', preparation === 'attachment' ? [{ name: 'notes.txt', type: 'text/plain', data: 'data:text/plain;base64,aGVsbG8=' }] : undefined, {
      instanceId: 'claude_code_default', model: 'fixture-model', interactionMode: 'default', permissionMode: 'full_access',
    })).then(Boolean); });
    await waitFor(() => expect(uploading).toBe(true));
    await act(async () => { await origin.reconcile(OWNER, 'chat_source'); });
    const committed = (await detail())!;
    expect(committed.record.chat.revision).toBe(before.record.chat.revision + 1);
    await waitFor(() => expect(hook!.result.current.routineFullAccessChat).toMatchObject({ revision: committed.record.chat.revision }));
    expect(hook.result.current.composerDraftRequest?.text).toBe('Unsent next owner draft');
    expect(hook.result.current.providerSelection).toEqual(selection);
    let accepted = false;
    await act(async () => { releaseUpload(); accepted = await submitted; });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.baseRevision).toBe(committed.record.chat.revision);
    expect(requests[0]!.permissionMode).toBe('full_access');
    expect(accepted).toBe(true);
  } finally {
    releaseUpload(); hook?.unmount(); events.shutdown(); wire?.close(); await origin.close(); await f.close(); await data.destroy();
  }
});

it('publishes only a committed source delivery once, with rollback and owner/Chat isolation', async () => {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
  if (!url) throw new Error('MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required');
  const data = await createRealBotStateDatabase(url), f = await proposalFixture(data.db, vi.fn);
  const owner = { type: 'personal' as const, ownerId: OWNER }, origin = originService(f);
  const stream = createCanonicalChatEventStream({ repository: f.chats });
  const current: CanonicalChatTransportFrame[] = [], other: CanonicalChatTransportFrame[] = [];
  try {
    const fire = await terminalFixtureFire(f); await fire.finish();
    const before = (await f.chats.get(owner, 'chat_source'))!;
    for (const [userId, frames] of [[OWNER, current], ['owner_unrelated', other]] as const) {
      await stream.open({ principal: { userId, source: 'jwt' }, content: true,
        sink: { send(frame) { frames.push(frame); return true; }, close() {} } });
    }
    current.length = 0; other.length = 0;
    await expect(f.chats.withTransaction(async tx => {
      await tx.appendRoutineReceipt(OWNER, { sourceChatId: 'chat_source', computerId: scope.computerId, fireId: fire.fireId, kind: 'output', now: f.state.clock });
      expect(current).toHaveLength(0); throw new Error('Synthetic transaction rollback');
    })).rejects.toThrow('Synthetic transaction rollback');
    expect(current).toHaveLength(0);
    expect((await f.chats.get(owner, 'chat_source'))!.chat.revision).toBe(before.chat.revision);
    await origin.reconcile(OWNER, 'chat_unrelated'); expect(current).toHaveLength(0);
    await origin.reconcile(OWNER, 'chat_source');
    const committed = current.filter(frame => frame.type === 'chat.content');
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({ event: { chatId: 'chat_source', revision: before.chat.revision + 1, eventType: 'chat.updated' },
      content: { record: { chat: { id: 'chat_source', revision: before.chat.revision + 1 } } } });
    expect(other).toHaveLength(0);
    await origin.reconcile(OWNER, 'chat_source');
    expect(current.filter(frame => frame.type === 'chat.content')).toHaveLength(1);
    expect((await f.chats.get(owner, 'chat_source'))!.chat.revision).toBe(before.chat.revision + 1);
    expect(f.runBot).not.toHaveBeenCalled();
  } finally { stream.shutdown(); await origin.close(); await f.close(); await data.destroy(); }
});
