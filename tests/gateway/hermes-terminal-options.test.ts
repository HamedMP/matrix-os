import { expect, it } from 'vitest';
import { nativeWorkflowConnectionOptions } from '../../packages/gateway/src/ai-providers/native-workflow-options.js';
it('offers provider-bound ChatGPT and Claude terminal logins for qualified Hermes without removing API keys', () => {
  const options = nativeWorkflowConnectionOptions({ harness: 'hermes', methods: ['terminal'], keyProviders: ['openai', 'anthropic', 'openrouter'] });
  expect(options.filter(option => option.authKind === 'subscription')).toEqual([
    { id: 'openai_terminal', providerId: 'openai', authKind: 'subscription', billingKind: 'subscription', executionKind: 'native', availability: 'available', method: 'terminal' },
    { id: 'anthropic_terminal', providerId: 'anthropic', authKind: 'subscription', billingKind: 'subscription', executionKind: 'native', availability: 'available', method: 'terminal' },
  ]);
  expect(options.filter(option => option.authKind === 'api_key').map(option => option.providerId)).toEqual(['openai', 'anthropic', 'openrouter']);
});
it('does not invent a Hermes browser or device-code workflow for an unqualified runtime', () => {
  expect(nativeWorkflowConnectionOptions({ harness: 'hermes', methods: ['browser', 'device_code'], keyProviders: [] })).toEqual([]);
});
