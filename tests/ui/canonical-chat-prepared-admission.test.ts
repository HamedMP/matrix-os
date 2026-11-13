import { expect, it, vi } from 'vitest';
import type { CanonicalChatDetailResponse, CanonicalChatRecord, CanonicalCreateChatTurnRequest } from '@matrix-os/contracts';
import { createCanonicalChatFixture } from '../contracts/fixtures/canonical-chat';
import { createCanonicalChatAdmissionTracker, ChatAdmissionUnconfirmed } from '../../packages/ui/src/canonical-chat-admission';
import { createCanonicalShellChatClient } from '../../shell/src/lib/canonical-chat-client';
import { admitShellChatTurn } from '../../shell/src/hooks/canonical-chat-turn-admission';

function fixture() {
  const { snapshot } = createCanonicalChatFixture('completed');
  const { project, providerBinding, activeRun, ...chat } = snapshot.chat;
  const detail: CanonicalChatDetailResponse = { record: { chat, projectId: project?.projectId, providerBinding, activeRun },
    messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs, activities: snapshot.activities };
  const input = { parts: [{ type: 'text' as const, text: 'Explicit next message' }], selection: snapshot.runs[0]!.selection,
    interactionMode: 'default', permissionMode: 'supervised' };
  return { detail, input };
}

it.each(['current', 'other Chat', 'other owner', 'older snapshot', 'lifecycle', 'selection', 'binding', 'project', 'active run'] as const)(
  'late-binds only an accepted same-context record before first dispatch: %s', mode => {
    const f = fixture(), tracker = createCanonicalChatAdmissionTracker();
    const attempt = tracker.prepare('owner/runtime', f.detail.record.chat.id, f.input);
    const current: CanonicalChatRecord = { ...f.detail.record, chat: { ...f.detail.record.chat, revision: f.detail.record.chat.revision + 1 } };
    if (mode === 'other Chat') current.chat.id = 'chat_unrelated';
    if (mode === 'other owner') current.chat.ownerScope = { type: 'personal', ownerId: 'owner_unrelated' };
    if (mode === 'older snapshot') current.chat.revision = f.detail.record.chat.revision - 1;
    if (mode === 'lifecycle') current.chat.lifecycle = 'archived';
    if (mode === 'selection') current.chat.currentSelection = { instanceId: 'codex_other', model: 'different' };
    if (mode === 'binding') current.providerBinding = { ...current.providerBinding!, instanceId: 'codex_other' };
    if (mode === 'project') current.projectId = 'different-project';
    if (mode === 'active run') current.activeRun = { runId: 'run_other', turnId: 'cturn_other', status: 'running' };
    const request = tracker.bind(attempt, f.detail.record, current)!;
    expect(request.baseRevision).toBe(f.detail.record.chat.revision + (mode === 'current' ? 1 : 0));
    expect(request.parts).toEqual(f.input.parts); expect(request.selection).toEqual(f.input.selection);
    expect(request.permissionMode).toBe('supervised');
  });

it('keeps an unknown body pinned while accepting a newer record before a manual retry', async () => {
  const f = fixture(), tracker = createCanonicalChatAdmissionTracker();
  const attempt = tracker.prepare('owner/runtime', f.detail.record.chat.id, f.input);
  tracker.bind(attempt, f.detail.record);
  const posts = vi.fn(async (_request: CanonicalCreateChatTurnRequest): Promise<never> => { throw new Error('Unknown result'); });
  const options = { post: posts, read: async () => ({ ...f.detail, turns: [] }), current: () => f.detail,
    isCurrent: () => true, onAccepted: vi.fn(), definitive: () => false };
  await expect(tracker.send(attempt, options)).rejects.toBeInstanceOf(ChatAdmissionUnconfirmed);
  tracker.bind(attempt, f.detail.record, { ...f.detail.record, chat: { ...f.detail.record.chat, revision: f.detail.record.chat.revision + 1 } });
  await expect(tracker.send(attempt, options)).rejects.toBeInstanceOf(ChatAdmissionUnconfirmed);
  expect(posts).toHaveBeenCalledTimes(2);
  expect(posts.mock.calls[1]![0]).toEqual(posts.mock.calls[0]![0]);
  expect(options.onAccepted).not.toHaveBeenCalled();
});

it.each(['selection', 'permission', 'parts'] as const)('rejects changed prepared browser %s intent', async change => {
  const f = fixture(), input = { ...f.input, permissionMode: 'full_access', clientRequestId: 'req_prepared_intent', baseRevision: 0 };
  const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ revision: 0, eligibility: 'eligible', origin: 'browser_required', consent: null, challenge: null }));
  const client = createCanonicalShellChatClient({ gatewayUrl: 'https://fixture.test', fetchFn });
  const post = await client.prepareTurnAdmission!(f.detail.record.chat.id, input);
  const changed = { ...input, baseRevision: 1 };
  if (change === 'selection') changed.selection = { instanceId: 'codex_other', model: 'different' };
  if (change === 'permission') changed.permissionMode = 'supervised';
  if (change === 'parts') changed.parts = [{ type: 'text', text: 'Different intent' }];
  await expect(post(changed)).rejects.toThrow('Chat intent changed');
  expect(fetchFn.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
});

it('releases undispatched browser preparations after authority loss so later owner sends remain available', async () => {
  const f = fixture(), tracker = createCanonicalChatAdmissionTracker();
  let current = true;
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method !== 'POST') {
      current = false;
      return Response.json({ revision: 0, eligibility: 'eligible', origin: 'browser_required', consent: null, challenge: null });
    }
    const request = JSON.parse(String(init.body)) as CanonicalCreateChatTurnRequest;
    const turn = f.detail.turns[0]!, run = f.detail.runs[0]!;
    return Response.json({ record: f.detail.record, message: f.detail.messages.find(m => m.id === turn.inputMessageId),
      turn: { ...turn, clientRequestId: request.clientRequestId }, run, admission: 'accepted' });
  });
  const client = createCanonicalShellChatClient({ gatewayUrl: 'https://fixture.test', fetchFn, captureAuthority: () => () => current });
  const onRejected = vi.fn(), onAccepted = vi.fn();
  const send = (index: number, permissionMode = 'full_access') => admitShellChatTurn({ tracker, identity: 'owner/runtime', client,
    record: f.detail.record, input: { ...f.input, permissionMode, parts: [{ type: 'text', text: `Owner request ${index}` }],
      clientRequestId: `req_preparation_${index}`, baseRevision: f.detail.record.chat.revision }, current: () => f.detail,
    isCurrent: () => current, onPrepared: vi.fn(), onConfirmed: vi.fn(), onRejected, onAccepted });
  for (let index = 0; index < 101; index++) {
    current = true;
    await expect(send(index)).rejects.toThrow('Chat context changed');
  }
  expect(onRejected).toHaveBeenCalledTimes(101);
  expect(fetchFn.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  current = true;
  await expect(send(102, 'supervised')).resolves.toMatchObject({ admission: 'accepted' });
  expect(onAccepted).toHaveBeenCalledTimes(1);
});

it('keeps an existing unknown admission pinned when a later browser preparation fails', async () => {
  const f = fixture(), tracker = createCanonicalChatAdmissionTracker(), identity = 'owner/runtime';
  const attempt = tracker.prepare(identity, f.detail.record.chat.id, f.input);
  tracker.bind(attempt, f.detail.record);
  await expect(tracker.send(attempt, { post: async () => { throw new Error('Synthetic unknown response'); },
    read: async () => ({ ...f.detail, turns: [] }), current: () => f.detail, isCurrent: () => true,
    onAccepted: vi.fn(), definitive: () => false })).rejects.toBeInstanceOf(ChatAdmissionUnconfirmed);
  const original = structuredClone(attempt.request);
  const client = { ...createCanonicalShellChatClient({ gatewayUrl: 'https://fixture.test', fetchFn: vi.fn() }),
    prepareTurnAdmission: async () => { throw new Error('Chat context changed'); } };
  const onRejected = vi.fn();
  await expect(admitShellChatTurn({ tracker, identity, client, record: f.detail.record,
    input: { ...f.input, clientRequestId: 'req_unknown_preparation', baseRevision: f.detail.record.chat.revision },
    current: () => f.detail, isCurrent: () => true, onPrepared: vi.fn(), onConfirmed: vi.fn(), onAccepted: vi.fn(), onRejected,
  })).rejects.toThrow('Chat context changed');
  expect(onRejected).not.toHaveBeenCalled();
  expect(tracker.prepare(identity, f.detail.record.chat.id, f.input)).toBe(attempt);
  expect(attempt.request).toEqual(original); expect(attempt.uncertain).toBe(true);
});

it('retains a concurrent same-attempt preparation when its peer fails before dispatch', async () => {
  const f = fixture(), tracker = createCanonicalChatAdmissionTracker(), identity = 'owner/runtime';
  type Post = (request: CanonicalCreateChatTurnRequest) => Promise<never>;
  let rejectFirst!: (error: Error) => void, resolveSecond!: (post: Post) => void;
  const first = new Promise<Post>((_resolve, reject) => { rejectFirst = reject; });
  const second = new Promise<Post>(resolve => { resolveSecond = resolve; });
  let preparations = 0;
  const client = { ...createCanonicalShellChatClient({ gatewayUrl: 'https://fixture.test', fetchFn: vi.fn() }),
    detail: async () => ({ ...f.detail, turns: [] }), prepareTurnAdmission: async () => preparations++ === 0 ? first : second };
  const ids: string[] = [], onRejected = vi.fn(), onAccepted = vi.fn();
  const send = () => admitShellChatTurn({ tracker, identity, client, record: f.detail.record,
    input: { ...f.input, clientRequestId: 'req_concurrent_preparation', baseRevision: f.detail.record.chat.revision },
    current: () => f.detail, isCurrent: () => true, onPrepared: id => { ids.push(id); }, onConfirmed: vi.fn(), onAccepted, onRejected });
  const pendingFirst = send(), pendingSecond = send();
  expect(preparations).toBe(2); expect(ids[1]).toBe(ids[0]);
  rejectFirst(new Error('Chat context changed'));
  await expect(pendingFirst).rejects.toThrow('Chat context changed');
  expect(onRejected).not.toHaveBeenCalled();
  const retained = tracker.prepare(identity, f.detail.record.chat.id, f.input);
  expect(retained.id).toBe(ids[0]);
  const post = vi.fn(async (_request: CanonicalCreateChatTurnRequest): Promise<never> => { throw new Error('Synthetic unknown response'); });
  resolveSecond(post);
  await expect(pendingSecond).rejects.toBeInstanceOf(ChatAdmissionUnconfirmed);
  expect(post).toHaveBeenCalledTimes(1); expect(post.mock.calls[0]![0].clientRequestId).toBe(ids[0]);
  expect(tracker.prepare(identity, f.detail.record.chat.id, f.input)).toBe(retained);
  expect(retained.uncertain).toBe(true); expect(onRejected).not.toHaveBeenCalled(); expect(onAccepted).not.toHaveBeenCalled();
});
