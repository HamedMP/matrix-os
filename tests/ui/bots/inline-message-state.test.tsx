// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotChatPanel } from '../../../packages/ui/src/chat-agents/bots/BotChatPanel.js';
import { BotRunMessageBody, BotUnassignedMessageBody } from '../../../packages/ui/src/chat-agents/bots/BotMessageBody.js';
import { BotTaskSummarySchema } from '@matrix-os/contracts';
import { ConversationTranscript } from '../../../desktop/src/renderer/src/components/conversation/transcript.js';
import { botTranscriptPlacement, BotTranscriptRunState, BotTranscriptFallback } from '../../../shell/src/components/BotTranscriptState.js';

beforeEach(() => { globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver; });

afterEach(cleanup);
const interaction = { interactionId: 'in_abcdefgh', chatId: 'chat_research', agentId: 'bot_research1', taskId: 'task_abcdefgh',
  kind: 'question', blocking: true, status: 'pending', expiresAt: '2099-01-01T00:00:00.000Z', revision: 1,
  payload: { kind: 'question', questions: [{ questionId: 'target', header: 'Target', question: 'Which company?', allowOther: true, secret: false }] } };
const task = { taskId: interaction.taskId, chatId: interaction.chatId, agentId: interaction.agentId,
  runId: 'run_abcdefgh', status: 'waiting_person', revision: 1, updatedAt: '2026-10-05T00:00:00.000Z' };
function clientFor(tasks = [task], requests = [interaction]) {
  return { bots: { directBot: vi.fn(async () => interaction.agentId), tasks: vi.fn(async () => tasks),
    interactions: vi.fn(async () => requests), authority: vi.fn(async () => ({ agentId: interaction.agentId, revision: 1, grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } })),
    resolve: vi.fn(async () => ({ interaction: { interactionId: interaction.interactionId, status: 'resolved', revision: 2 } })) },
    list: vi.fn(async () => ({ enabled: true, agents: [] })) };
}
it('keeps question and waiting status in their exact run body, outside the identity header', async () => {
  const client = clientFor();
  render(<BotChatPanel chatId={interaction.chatId} client={client as never}>
    <section aria-label="Transcript"><article data-agent-message-body="run_other"><BotRunMessageBody runIds={['run_other']}/></article>
      <article data-agent-message-body={task.runId}><span>Asking you</span><BotRunMessageBody runIds={[task.runId]}/></article>
      <BotUnassignedMessageBody runIds={[task.runId, 'run_other']}/></section>
  </BotChatPanel>);
  const question = await screen.findByText('Which company?');
  expect(question.closest('[data-agent-message-body]')?.getAttribute('data-agent-message-body')).toBe(task.runId);
  expect(screen.getByText('Waiting for your answer').closest('[data-agent-message-body]')?.getAttribute('data-agent-message-body')).toBe(task.runId);
  expect(document.querySelector('.matrix-bot-chat-header')?.textContent).not.toMatch(/Which company|Waiting for/);
  expect(screen.getAllByText('Which company?')).toHaveLength(1);
  fireEvent.change(screen.getByRole('textbox', { name: 'Answer Target' }), { target: { value: 'Acme' } });
  fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
  await waitFor(() => expect(client.bots.resolve).toHaveBeenCalledWith(interaction.chatId, interaction.interactionId,
    { kind: 'question', baseRevision: 1, structuredAnswers: { target: ['Acme'] } }));
  await waitFor(() => expect(client.bots.interactions.mock.calls.length).toBeGreaterThan(1));
});
it('keeps unanswered legacy requests reachable in a transcript fallback without guessing another run', async () => {
  const { runId: _, ...legacy } = task;
  render(<BotChatPanel chatId={interaction.chatId} client={clientFor([legacy as typeof task]) as never}>
    <section aria-label="Transcript"><article data-agent-message-body="run_other"><BotRunMessageBody runIds={['run_other']}/></article>
      <BotUnassignedMessageBody runIds={['run_other']}/></section>
  </BotChatPanel>);
  const question = await screen.findByText('Which company?');
  expect(question.closest('[data-agent-message-body]')?.getAttribute('data-agent-message-body')).toBe('unassigned');
  expect(within(screen.getByRole('region', { name: 'Transcript' })).getByRole('button', { name: 'Answer' })).toBeTruthy();
});
it('deduplicates only a canonical request with the identical request ID', async () => {
  render(<BotChatPanel chatId={interaction.chatId} client={clientFor() as never}>
    <section aria-label="Transcript"><span>Canonical question</span><BotRunMessageBody runIds={[task.runId]} requestIds={[interaction.interactionId]}/>
      <BotUnassignedMessageBody runIds={[task.runId]}/></section>
  </BotChatPanel>);
  await waitFor(() => expect(screen.getByText('Waiting for your answer')).toBeTruthy());
  expect(screen.queryByText('Which company?')).toBeNull();
});
it('accepts exact run ownership while remaining compatible with older task summaries', () => {
  expect(BotTaskSummarySchema.parse(task).runId).toBe(task.runId);
  const { runId: _, ...legacy } = task;
  expect(BotTaskSummarySchema.parse(legacy).runId).toBeUndefined();
  expect(BotTaskSummarySchema.safeParse({ ...task, runId: 'invented' }).success).toBe(false);
});

it('places Bot state inside the existing Electron turn and keeps unrelated turn bodies clean', async () => {
  render(<BotChatPanel chatId={interaction.chatId} client={clientFor() as never}>
    <ConversationTranscript turns={[{ id: 'turn_other', runIds: ['run_other'], startedAt: 1, endedAt: 2, active: false, work: [] },
      { id: 'turn_abcdefgh', runIds: [task.runId], startedAt: 3, endedAt: 4, active: false, work: [],
        final: { kind: 'message', id: 'msg_abcdefgh', role: 'assistant', phase: 'final', markdown: 'I need your answer.', copyText: 'I need your answer.', timestamp: 4 } }]} callbacks={{ copyText: vi.fn() }}/>
  </BotChatPanel>);
  const question = await screen.findByText('Which company?');
  expect(question.closest('[data-agent-message-body]')?.getAttribute('data-agent-message-body')).toBe('turn_abcdefgh');
  expect(question.closest('[data-slot="message-scroller-content"]')).toBeTruthy();
  expect(document.querySelector('[data-agent-message-body="turn_other"]')?.textContent).not.toMatch(/Which company|Waiting/);
});
it('places Web state once after the last row of its canonical run, including a tool-only turn', async () => {
 const messages = [{ id: 'tool_a', role: 'system' as const, content: 'Asking you', tool: 'interaction.create', requestId: task.runId, timestamp: 3 },
   { id: 'reply_a', role: 'assistant' as const, content: 'I need your answer.', requestId: task.runId, timestamp: 4 }];
 const groups = [{ type: 'tool_group' as const, messages: [messages[0]!] }, { type: 'message' as const, message: messages[1]! }];
 render(<BotChatPanel chatId={interaction.chatId} client={clientFor() as never}>
   <section aria-label="Transcript">{groups.map((group, index) => <div key={index} data-row={index}><BotTranscriptRunState placement={botTranscriptPlacement(groups)} index={index}/></div>)}
   <BotTranscriptFallback placement={botTranscriptPlacement(groups)}/></section>
 </BotChatPanel>);
 const question = await screen.findByText('Which company?');
 expect(question.closest('[data-row]')?.getAttribute('data-row')).toBe('1');
 expect(screen.getAllByText('Which company?')).toHaveLength(1);
});
it('continues the same task in its new run after a confirmed answer and drops the old pending card', async () => {
  const client = clientFor();
  client.bots.interactions.mockResolvedValueOnce([interaction]).mockResolvedValue([]);
  client.bots.tasks.mockResolvedValueOnce([task]).mockResolvedValue([{ ...task, runId: 'run_continued', status: 'running' }]);
  render(<BotChatPanel chatId={interaction.chatId} client={client as never}>
    <article data-agent-message-body={task.runId}><BotRunMessageBody runIds={[task.runId]}/></article>
    <article data-agent-message-body="run_continued"><BotRunMessageBody runIds={['run_continued']}/></article>
    <BotUnassignedMessageBody runIds={[task.runId, 'run_continued']}/>
  </BotChatPanel>);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Answer Target' }), { target: { value: 'Acme' } });
  fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
  const progress = await screen.findByText('Working');
  expect(progress.closest('[data-agent-message-body]')?.getAttribute('data-agent-message-body')).toBe('run_continued');
  expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull();
  expect(screen.queryByText('Waiting for your answer')).toBeNull();
});
it('keeps independent permission approvals actionable when an identical question is represented canonically', async () => {
  const approval = { ...interaction, interactionId: 'in_approval1', kind: 'approval', payload: { kind: 'approval', tool: 'gmail.send',
    argsDigest: 'a'.repeat(64), audience: 'direct', preview: 'Send the brief', policyRevision: 1 } };
  const client = clientFor([task], [interaction, approval as typeof interaction]);
  render(<BotChatPanel chatId={interaction.chatId} client={client as never}>
    <article data-agent-message-body={task.runId}><BotRunMessageBody runIds={[task.runId]} requestIds={[interaction.interactionId]}/></article>
    <BotUnassignedMessageBody runIds={[task.runId]}/>
  </BotChatPanel>);
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(client.bots.resolve).toHaveBeenCalledWith(interaction.chatId, approval.interactionId,
    { kind: 'approval', baseRevision: 1, decision: 'approve' }));
  expect(screen.queryByText('Which company?')).toBeNull();
});
it('keeps reopened pending questions reachable while a failed status refresh disables actions', async () => {
 const client = clientFor();
 client.bots.interactions.mockResolvedValueOnce([interaction]).mockRejectedValue(new Error('private connection error'));
 const content = <article data-agent-message-body={task.runId}><BotRunMessageBody runIds={[task.runId]}/></article>;
 const view = render(<BotChatPanel chatId={interaction.chatId} client={client as never} refreshKey={0}>{content}</BotChatPanel>);
 await screen.findByRole('button', { name: 'Answer' });
 view.rerender(<BotChatPanel chatId={interaction.chatId} client={client as never} refreshKey={1}>{content}</BotChatPanel>);
 await screen.findByRole('alert');
 expect(screen.getByText('Which company?').closest('[data-agent-message-body]')?.getAttribute('data-agent-message-body')).toBe(task.runId);
 expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull();
 expect(screen.getByRole('alert').textContent).not.toMatch(/private|connection error/);
});

it("retains unanswered legacy questions after an older canonical input is resolved", async () => {
  const { runId: _, ...legacy } = task;
  const messages = [{ id: "input_saved", role: "system" as const, content: "Saved input", timestamp: 4,
    metadata: { canonicalInput: { requestId: interaction.interactionId, pending: false, submitted: true, resolved: true } } }];
  const placement = botTranscriptPlacement(messages.map(message => ({ type: "message" as const, message })));
  expect(placement.requestIds).toEqual([]);
  render(<BotChatPanel chatId={interaction.chatId} client={clientFor([legacy as typeof task]) as never}>
    <section aria-label="Transcript"><BotTranscriptFallback placement={placement}/></section>
  </BotChatPanel>);
  expect(await screen.findByRole("button", { name: "Answer" })).toBeTruthy();
});
it("avoids a duplicate pending native request in the legacy transcript fallback", async () => {
  const { runId: _, ...legacy } = task;
  const messages = [{ id: "input_saved", role: "system" as const, content: "Saved input", timestamp: 4,
    metadata: { canonicalInput: { requestId: interaction.interactionId, pending: true, submitted: false, resolved: false } } }];
  const placement = botTranscriptPlacement(messages.map(message => ({ type: "message" as const, message })));
  render(<BotChatPanel chatId={interaction.chatId} client={clientFor([legacy as typeof task]) as never}>
    <section aria-label="Transcript"><span>Native request</span><BotTranscriptFallback placement={placement}/></section>
  </BotChatPanel>);
  await screen.findByText("Waiting for your answer");
  expect(screen.queryByText("Which company?")).toBeNull();
});
