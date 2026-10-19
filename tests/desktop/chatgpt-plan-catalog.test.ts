import { describe, expect, it } from 'vitest';
import { ChatGptPlanPeerSnapshotSchema } from '@matrix-os/contracts';
import { planCatalog } from '../../desktop/src/main/chatgpt-plan/provider';
import { withChatGptPlanProviderInstance } from '../../packages/gateway/src/bots/chatgpt-plan-provider-instance';
import { validateChatProviderSelection } from '../../packages/gateway/src/chat/provider-catalog';

const row = (extra: Record<string, unknown> = {}) => ({
  slug: 'fixture-model', display_name: 'Fixture model', visibility: 'list', ...extra,
});
const catalog = (...models: ReturnType<typeof row>[]) => planCatalog({ models });

describe('native subscription model modality projection', () => {
  it('preserves explicit upstream image support through the strict peer snapshot', () => {
    const models = catalog(row({ input_modalities: ['text', 'image'] }));
    expect(models[0]?.input).toEqual(['text', 'image']);
    expect(ChatGptPlanPeerSnapshotSchema.parse({
      deviceId: 'a'.repeat(64),
      accountId: '00000000-0000-4000-8000-000000000001',
      grantRevision: 1, enabled: true, background: false, models,
    }).models[0]?.input).toEqual(['text', 'image']);
  });

  it('does not infer images from a GPT name, hidden model or arbitrary capability field', () => {
    const models = catalog(
      row({ slug: 'gpt-6.1-sol', input_modalities: ['text'], supportsVision: true }),
      row({ slug: 'missing', display_name: 'Vision', capabilities: ['image'] }),
      row({ slug: 'hidden', visibility: 'hidden', input_modalities: ['text', 'image'] }),
    );
    expect(models.map(model => [model.id, model.input])).toEqual([
      ['gpt-6.1-sol', ['text']], ['missing', ['text']],
    ]);
  });

  it('carries parsed upstream modalities into ordinary Chat and recipe Bot capabilities', async () => {
    const models = catalog(row({ input_modalities: ['text', 'image'] }),
      row({ slug: 'text-only', input_modalities: ['text'] }));
    const result = await withChatGptPlanProviderInstance({
      getCatalog: async () => ({ revision: 'base', drivers: [], instances: [] }),
    }, { observe: async () => ({
      id: 'matrix_chatgpt_plan', accountId: 'fixture-account', providerId: 'openai',
      executionKind: 'direct_pi', availability: 'available', models,
      authorization: { revision: 1, enabled: true, background: false }, coordinatorFunding: 'subscription',
    }) }, () => true).getCatalog({ userId: 'owner', source: 'jwt' });
    expect(result.instances.map(instance => instance.id).sort())
      .toEqual(['matrix_chatgpt_plan', 'matrix_pi_chatgpt_plan']);
    for (const instance of result.instances) {
      expect(instance.models[0]).toMatchObject({ supportsVision: true, capabilities: ['tools', 'vision'] });
      expect(instance.models[1]).toMatchObject({ supportsVision: false, capabilities: ['tools'] });
    }
  });

  it('rejects images after native projection for explicit text-only and legacy missing metadata', async () => {
    const models = catalog(row({ slug: 'text-only', input_modalities: ['text'] }),
      row({ slug: 'legacy-missing' }), row({ slug: 'vision', input_modalities: ['text', 'image'] }));
    const projected = await withChatGptPlanProviderInstance({
      getCatalog: async () => ({ revision: 'base', drivers: [], instances: [] }),
    }, { observe: async () => ({
      id: 'matrix_chatgpt_plan', accountId: 'fixture-account', providerId: 'openai',
      executionKind: 'direct_pi', availability: 'available', models,
      authorization: { revision: 1, enabled: true, background: false }, coordinatorFunding: 'subscription',
    }) }, () => true).getCatalog({ userId: 'owner', source: 'jwt' });
    for (const instance of projected.instances) {
      for (const model of ['text-only', 'legacy-missing']) {
        const selection = { ...instance.defaultSelection!, model };
        for (const requirements of [
          { attachments: ['image' as const] },
          { attachments: ['image' as const], attachmentInputs: [{ kind: 'image' as const, mimeType: 'image/png', sizeBytes: 1750 }] },
        ]) {
          expect(validateChatProviderSelection({ catalog: projected, selection, requirements }))
            .toMatchObject({ ok: false, error: { code: 'capability_mismatch', safeMessage: 'The selected model does not support images.' } });
        }
        expect(validateChatProviderSelection({ catalog: projected, selection,
          requirements: { attachments: ['file'], attachmentInputs: [{ kind: 'file', sizeBytes: 92 }] },
        }).ok).toBe(true);
      }
      expect(validateChatProviderSelection({ catalog: projected,
        selection: { ...instance.defaultSelection!, model: 'vision' },
        requirements: { attachments: ['image'], attachmentInputs: [{ kind: 'image', mimeType: 'image/png', sizeBytes: 1750 }] },
      }).ok).toBe(true);
    }
  });

  it('projects only supported modalities, normalizes order and duplicates', () => {
    expect(catalog(row({ input_modalities: ['image', 'text', 'audio'] }))[0]?.input)
      .toEqual(['text', 'image']);
    expect(catalog(row({ input_modalities: ['text', 'image', 'image'] }))[0]?.input)
      .toEqual(['text', 'image']);
  });

  it('does not publish models that explicitly omit text required by the peer transport', () => {
    expect(catalog(row({ input_modalities: [] }))).toEqual([]);
    expect(catalog(row({ input_modalities: ['audio'] }))).toEqual([]);
    expect(catalog(row({ input_modalities: ['image'] }))).toEqual([]);
  });

  it.each([null, 'image', ['text', 'unknown'], ['text', 1], Array(4).fill('text')]
    .map(input_modalities => ({ input_modalities })))(
    'rejects malformed or oversized explicit modality metadata $input_modalities', ({ input_modalities }) => {
      expect(() => catalog(row({ input_modalities }))).toThrow();
    },
  );

  it('keeps duplicate visible ID rejection, model bounds and metadata stripping', () => {
    expect(() => catalog(row(), row())).toThrow();
    expect(() => catalog(...Array.from({ length: 257 }, (_, i) => row({ slug: `model-${i}` })))).toThrow();
    const models = catalog(...Array.from({ length: 65 }, (_, i) => row({ slug: `model-${i}`, description: 'private metadata' })));
    expect(models).toHaveLength(64);
    expect(JSON.stringify(models)).not.toContain('private metadata');
    expect(models[0]).toMatchObject({ contextWindow: 32768, maxOutputTokens: 4096 });
  });
});
