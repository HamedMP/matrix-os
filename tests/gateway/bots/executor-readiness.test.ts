import { describe, expect, it, vi } from 'vitest';
import type { BotExecutionBinding } from '@matrix-os/contracts';
import { createBotExecutorReadiness } from '../../../packages/gateway/src/bots/executor-readiness.js';

function setup({owner = 'owner', computer = 'computer', nativeTasks = true} = {}) {
  const execution = vi.fn(async (): Promise<BotExecutionBinding> => ({ revision: 0, connectionId: null, model: null, grantRevision: null }));
  const admit = vi.fn(async () => ({ model: 'fixture', revision: 1, grantRevision: 1, sessionId: null }));
  const ready = createBotExecutorReadiness({runtimeOwnerId: owner, computerId: computer, nativeTasks, connections: {execution, admit}});
  return {ready, execution, admit};
}

describe('optional Bot task executor readiness', () => {
  it('lets a shared Preview reviewer run coordinator tools without accessing native owner connections', async () => {
    const s = setup();
    await expect(s.ready('reviewer', 'bot_fixture')).resolves.toBe(false);
    expect(s.execution).not.toHaveBeenCalled();
    expect(s.admit).not.toHaveBeenCalled();
  });
  it.each([{owner: ''}, {computer: ''}])('omits native tasks when the computer binding is absent (%o)', async input => {
    const s = setup(input);
    await expect(s.ready('owner', 'bot_fixture')).resolves.toBe(false);
    expect(s.execution).not.toHaveBeenCalled();
  });
  it('does not require Claude consent for an owner Bot with tools only', async () => {
    const s = setup();
    await expect(s.ready('owner', 'bot_fixture')).resolves.toBe(false);
    expect(s.execution).toHaveBeenCalledWith('owner', 'bot_fixture');
    expect(s.admit).not.toHaveBeenCalled();
  });
  it('still rejects a saved native executor whose authorization is revoked', async () => {
    const s = setup(); s.execution.mockResolvedValue({revision: 1, connectionId: 'claude_code_tasks', model: 'fixture', grantRevision: 1});
    s.admit.mockRejectedValue(new Error('revoked'));
    await expect(s.ready('owner', 'bot_fixture')).rejects.toThrow('revoked');
  });
  it.each([true, false])('advertises only a freshly admitted available native executor (%s)', async nativeTasks => {
    const s = setup({nativeTasks}); s.execution.mockResolvedValue({revision: 1, connectionId: 'claude_code_tasks', model: 'fixture', grantRevision: 1});
    await expect(s.ready('owner', 'bot_fixture')).resolves.toBe(nativeTasks);
    expect(s.admit).toHaveBeenCalledWith('owner', 'bot_fixture', 'interactive');
  });
});
