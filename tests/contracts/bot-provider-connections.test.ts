import { describe, expect, it } from 'vitest';
import { BotProviderConnectionsSchema, BotExecutionBindingSchema } from '../../packages/contracts/src/bots/provider-connections.js';
const connection = { id: 'claude_code_tasks', providerId: 'anthropic', executionKind: 'native_task', availability: 'available', models: [{ id: 'observed', displayName: 'Observed' }], authorization: { revision: 1, enabled: true, background: false }, coordinatorFunding: 'separate' };
describe('Bot native connection contracts', () => {
  it('rejects duplicate sources, altered executor/provider pairing and dishonest availability', () => {
    expect(BotProviderConnectionsSchema.safeParse({ connections: [connection] }).success).toBe(true);
    for (const connections of [[connection, connection], [{ ...connection, providerId: 'openai' }], [{ ...connection, executionKind: 'direct_pi' }],
      [{ ...connection, availability: 'unavailable' }], [{ ...connection, availability: 'available', unavailableReason: 'authorization_required' }],
      [{ ...connection, models: [] }], [{ ...connection, authorization: { ...connection.authorization, enabled: false } }]]) {
      expect(BotProviderConnectionsSchema.safeParse({ connections }).success).toBe(false);
    }
  });
  it('requires all binding references together', () => {
    expect(BotExecutionBindingSchema.safeParse({ revision: 0, connectionId: null, model: null, grantRevision: null }).success).toBe(true);
    expect(BotExecutionBindingSchema.safeParse({ revision: 1, connectionId: null, model: 'observed', grantRevision: 1 }).success).toBe(false);
  });
});
