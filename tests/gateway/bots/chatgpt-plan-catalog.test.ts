import { describe, expect, it, vi } from 'vitest';
import { CanonicalProviderCatalogSchema } from '@matrix-os/contracts';
import { createCanonicalProviderCatalogFixture } from '../../contracts/fixtures/canonical-chat';
import { ChatGptPlanPeerError } from '../../../packages/gateway/src/bots/chatgpt-plan-peers.js';
import { withChatGptPlanProviderInstance } from '../../../packages/gateway/src/bots/chatgpt-plan-provider-instance.js';
const connection = { id: 'matrix_chatgpt_plan', accountId: 'account-local', providerId: 'openai', executionKind: 'direct_pi', availability: 'available', models: [{ id: 'gpt-account-model', displayName: 'Account model' }], authorization: { revision: 5, enabled: true, background: false }, coordinatorFunding: 'separate' } as const;
describe('owner-local Bot coordinator catalog', () => {
    it('keeps another principal base catalog healthy and does not project private account metadata', async () => {
        const base = createCanonicalProviderCatalogFixture();
        const wrapped = withChatGptPlanProviderInstance({ getCatalog: async () => base }, {
            observe: async () => { throw new ChatGptPlanPeerError('forbidden'); },
        });
        const result = await wrapped.getCatalog({ userId: 'collaborator', source: 'jwt' });
        expect(result).toEqual(base);
        expect(JSON.stringify(result)).not.toContain('account-local');
        expect(result.instances.some(instance => instance.id === 'matrix_chatgpt_plan')).toBe(false);
    });
    it('updates all existing descriptor revisions when adding the owner source', async () => {
        const wrapped = withChatGptPlanProviderInstance({ getCatalog: async () => createCanonicalProviderCatalogFixture() }, { observe: async () => connection } as never);
        const result = CanonicalProviderCatalogSchema.parse(await wrapped.getCatalog({ userId: 'owner', source: 'jwt' }));
        expect(result.instances.length).toBeGreaterThan(1);
        expect(result.instances.every(instance => instance.catalogRevision === result.revision)).toBe(true);
    });
    it('projects account and grant options into the existing Bot adapter without credential metadata', async () => {
        const wrapped = withChatGptPlanProviderInstance({ getCatalog: async () => ({ revision: 'base1', drivers: [], instances: [] }) }, { observe: vi.fn(async () => connection) } as never);
        const result = CanonicalProviderCatalogSchema.parse(await wrapped.getCatalog({ userId: 'owner', source: 'jwt' }));
        expect(result.instances[0]).toMatchObject({ id: 'matrix_chatgpt_plan', driverKind: 'matrix_bot', defaultSelection: { instanceId: 'matrix_chatgpt_plan', model: 'gpt-account-model', options: [{ id: 'accountId', value: 'account-local' }, { id: 'grantRevision', value: '5' }] } });
        expect(JSON.stringify(result)).not.toMatch(/access_token|refresh_token|client_id/);
    });
    it('omits executable models and defaults when owner device/grant is absent', async () => {
        const wrapped = withChatGptPlanProviderInstance({ getCatalog: async () => ({ revision: 'base1', drivers: [], instances: [] }) }, { observe: async () => ({ ...connection, availability: 'unavailable', models: [], authorization: { revision: 6, enabled: false, background: false }, unavailableReason: 'unsupported_runtime' }) } as never);
        const result = CanonicalProviderCatalogSchema.parse(await wrapped.getCatalog({ userId: 'owner', source: 'jwt' }));
        expect(result.instances[0]).toMatchObject({ availability: 'unavailable', models: [] });
        expect(result.instances[0]).not.toHaveProperty('defaultSelection');
    });
});
