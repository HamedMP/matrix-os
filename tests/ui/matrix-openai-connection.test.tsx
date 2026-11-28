// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { MatrixOpenAiConnection } from '@matrix-os/contracts';
import { MatrixAnthropicConnectionCard } from '../../packages/ui/src/agents-providers/MatrixAnthropicConnectionCard.js';
import { createProviderWorkflowClient } from '../../packages/ui/src/agents-providers/provider-workflow-client.js';
afterEach(cleanup);
const generation = '47ed04c6-d276-4ec2-a9f1-f7b2e071cb3c';
const status: MatrixOpenAiConnection = { connectionId: 'matrix_openai_api', providerId: 'openai', executionKind: 'direct_pi', billingKind: 'api_key', revision: 0, enabled: false,
  credentialGeneration: null, sourceCredentialGeneration: null, state: 'disconnected', models: [], actions: ['connect'], checkedAt: null, staleAfter: null, supports: { rootChat: true, recipeBots: true } };
it('offers a separate OpenAI API key through existing owner-scoped transport and clears submitted key', async () => {
  const request = vi.fn(async (input: { path: string; method: string; body?: unknown }) => input.method === 'GET' ? status : ({ ...status, state: 'ready', revision: 1, enabled: true,
    credentialGeneration: generation, sourceCredentialGeneration: generation, models: [{ id: 'gpt-4.1', displayName: 'gpt-4.1' }], actions: ['connect', 'refresh', 'disconnect'], checkedAt: '2026-10-24T00:00:00.000Z', staleAfter: '2026-10-24T00:05:00.000Z' }));
  const workflow = createProviderWorkflowClient(request), changed = vi.fn();
  render(<MatrixAnthropicConnectionCard provider="openai" client={workflow.matrixOpenAi} disabled={false} readOnly={false} onChanged={changed}/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect OpenAI' }));
  fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: 'sk-synthetic-test-only' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect OpenAI' })); await screen.findByText('Connected');
  expect(request.mock.calls[1]![0]).toMatchObject({ path: '/api/ai/matrix-connections/openai/connect', body: { apiKey: 'sk-synthetic-test-only', expectedRevision: 0, expectedCredentialGeneration: null } });
  expect(screen.queryByLabelText('OpenAI API key')).toBeNull(); expect(changed).toHaveBeenCalledOnce();
});
it('does not treat a native subscription or secret-bearing receipt as an explicit API connection', async () => {
  const request = vi.fn(async (_input: { path: string; method: string }) => ({ ...status, billingKind: 'subscription', apiKey: 'private-synthetic' }));
  const client = createProviderWorkflowClient(request).matrixOpenAi!;
  await expect(client.status(new AbortController().signal)).rejects.toThrow();
  expect(request).toHaveBeenCalledOnce(); expect(request.mock.calls[0]![0]).toMatchObject({ path: '/api/ai/matrix-connections/openai', method: 'GET' });
});
it('keeps owner API billing out of automatic defaults and rejects stale picker binding', async () => {
  const { projectMatrixOpenAiProviderInstances } = await import('../../packages/gateway/src/bots/matrix-openai-provider-instance.js');
  const { canonicalProviderChoiceCanBeDefault, canonicalChatSubscriptionSelectionMatches, deriveCanonicalProviderChoices } = await import('../../packages/ui/src/canonical-provider-choice.js');
  const ready = { ...status, revision: 1, enabled: true, state: 'ready' as const, credentialGeneration: generation, sourceCredentialGeneration: generation,
    models: [{ id: 'gpt-4.1', displayName: 'gpt-4.1' }], actions: ['connect', 'refresh', 'disconnect'] as const, checkedAt: '2026-10-24T00:00:00.000Z', staleAfter: '2026-10-24T00:05:00.000Z' };
  const catalog = projectMatrixOpenAiProviderInstances({ revision: 'base', drivers: [], instances: [] }, ready as MatrixOpenAiConnection, true);
  const chat = catalog.instances.find(instance => instance.id === 'matrix_pi_openai_api')!;
  expect(canonicalProviderChoiceCanBeDefault({ instanceId: chat.id })).toBe(false);
  expect(canonicalChatSubscriptionSelectionMatches(chat, chat.defaultSelection!.options)).toBe(true);
  const stale = chat.defaultSelection!.options!.map(option => option.id === 'credentialGeneration' ? { ...option, value: 'a6cf6d9a-2198-4167-ac86-b0bdc7fe87fe' } : option);
  expect(canonicalChatSubscriptionSelectionMatches(chat, stale)).toBe(false);
  const completion = chat.defaultSelection!.options!.map(option => option.id === 'api' ? { ...option, value: 'openai-completions' } : option);
  expect(canonicalChatSubscriptionSelectionMatches(chat, completion)).toBe(true);
  expect(deriveCanonicalProviderChoices(catalog).find(choice => choice.instanceId === chat.id)?.selectedOptions).toEqual(chat.defaultSelection!.options);
});
