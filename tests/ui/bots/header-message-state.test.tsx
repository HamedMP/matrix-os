// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BotChatPanel } from '../../../packages/ui/src/chat-agents/bots/BotChatPanel.js';
import { saved } from '../../desktop/chat-agents-fixture.js';
afterEach(cleanup);
it('keeps task progress out of Bot identity chrome', async () => {
 const client = { bots: { directBot: vi.fn(async () => 'bot_research1'), interactions: vi.fn(async () => []),
  tasks: vi.fn(async () => [{ taskId: 'task_abcdefgh', chatId: 'chat_research', agentId: 'bot_research1', status: 'running', revision: 1, updatedAt: '2026-10-05T00:00:00.000Z' }]),
  authority: vi.fn(async () => ({ agentId: 'bot_research1', revision: 1, grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } })) },
  list: vi.fn(async () => ({ enabled: true, agents: [{ ...saved, id: 'bot_research1',
    recipeRef: { recipeId: 'writing-bot', version: '1' } }] })) };
 render(<BotChatPanel chatId="chat_research" client={client as never}/>);
 const status = await screen.findByText('Working');
 expect(status.closest('.matrix-bot-chat-header')).toBeNull();
 expect(status.closest('[data-agent-message-body]')).toBeTruthy();
});
