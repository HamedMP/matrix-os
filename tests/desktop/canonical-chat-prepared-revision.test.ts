import { expect, it, vi } from 'vitest';
import { createCanonicalChatAdmissionTracker, ChatAdmissionUnconfirmed } from '../../packages/ui/src/canonical-chat-admission';
import { admitDesktopChatTurn } from '../../desktop/src/renderer/src/features/chat/canonical-chat-turn-admission';
import { AppError } from '../../desktop/src/shared/app-error';
import { createCanonicalChatFixture } from '../contracts/fixtures/canonical-chat';
import type { CanonicalChatClient } from '../../desktop/src/renderer/src/lib/canonical-chat-client';
import type { CanonicalChatDetailResponse } from '@matrix-os/contracts';

const { snapshot } = createCanonicalChatFixture('completed');

async function fixture() {
  const { project, providerBinding, activeRun, ...chat } = snapshot.chat;
  const detail: CanonicalChatDetailResponse = { record: { chat, providerBinding, activeRun, projectId: project?.projectId },
    messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs, activities: snapshot.activities };
  // This actual admission helper uses only these three transport methods.
  const client = { getDetail: vi.fn(async () => detail), create: vi.fn(), admitTurn: vi.fn() } as unknown as CanonicalChatClient;
  let current = { ...detail, record: { ...detail.record, chat: { ...detail.record.chat, revision: detail.record.chat.revision + 1 } } };
  const tracker = createCanonicalChatAdmissionTracker();
  const input = { parts: [{ type: 'text' as const, text: 'Next explicit owner message' }], selection: snapshot.runs[0]!.selection,
    interactionMode: 'default', permissionMode: 'supervised', clientRequestId: 'req_prepared_revision' };
  const onAccepted = vi.fn();
  const submit = (mayDispatch = true) => admitDesktopChatTurn({ client, tracker, identity: 'owner/runtime', scope: snapshot.chat.id,
    input, title: 'Next message', projectId: detail.record.projectId ?? null, detail, current: () => current,
    onSnapshot: vi.fn(), isCurrent: () => true, mayDispatch: () => mayDispatch, canAcknowledge: () => true,
    onAccepted, onConfirmed: vi.fn(), onPrepared: vi.fn() });
  return { client, detail, input, submit, onAccepted, advance() { current = { ...current, record: { ...current.record, chat: { ...current.record.chat, revision: current.record.chat.revision + 1 } } }; } };
}

it('native admission binds the latest accepted same-Chat record before its first transport call', async () => {
  const f = await fixture();
  vi.mocked(f.client.admitTurn).mockImplementation(async (_id, request) => ({ record: f.detail.record,
    message: { ...snapshot.messages[0]!, parts: request.parts }, turn: { ...snapshot.turns[0]!, clientRequestId: request.clientRequestId },
    run: snapshot.runs[0]!, admission: 'accepted' }));
  await f.submit();
  expect(f.client.admitTurn).toHaveBeenCalledTimes(1);
  expect(vi.mocked(f.client.admitTurn).mock.calls[0]![1]).toMatchObject({ baseRevision: f.detail.record.chat.revision + 1,
    parts: f.input.parts, selection: f.input.selection, permissionMode: 'supervised' });
  expect(f.onAccepted).toHaveBeenCalledTimes(1);
});

it('native manual retry preserves its unknown request after a newer record is accepted', async () => {
  const f = await fixture(); vi.mocked(f.client.admitTurn).mockRejectedValue(new AppError('timeout'));
  await expect(f.submit()).rejects.toBeInstanceOf(ChatAdmissionUnconfirmed);
  f.advance();
  await expect(f.submit()).rejects.toBeInstanceOf(ChatAdmissionUnconfirmed);
  const calls = vi.mocked(f.client.admitTurn).mock.calls;
  expect(calls).toHaveLength(2); expect(calls[1]![1]).toEqual(calls[0]![1]);
  expect(f.onAccepted).not.toHaveBeenCalled();
});

it('native authority or selection loss prevents dispatch even with a newer record available', async () => {
  const f = await fixture(); expect(await f.submit(false)).toBeNull();
  expect(f.client.admitTurn).not.toHaveBeenCalled(); expect(f.onAccepted).not.toHaveBeenCalled();
});
