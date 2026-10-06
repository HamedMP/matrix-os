import { createHash } from 'node:crypto';
import type { CanonicalProviderCatalog, CanonicalProviderInstanceDescriptor, CanonicalChatModelSelection } from '@matrix-os/contracts';
import type { ChatProviderCatalogService } from '../chat/provider-catalog.js';
import type { RequestPrincipal } from '../request-principal.js';
import type { ChatGptPlanAuthority } from './chatgpt-plan.js';
import { ChatGptPlanPeerError } from './chatgpt-plan-peers.js';
import { MATRIX_BOT_DRIVER } from './provider-instance.js';
/** Own account, native-online plan route. Ordinary Chats cannot run it: the
 * agent-context boundary accepts this descriptor only for a bound direct Bot. */
export function withChatGptPlanProviderInstance(base: Pick<ChatProviderCatalogService, 'getCatalog'>, authority: Pick<ChatGptPlanAuthority, 'observe'>): Pick<ChatProviderCatalogService, 'getCatalog'> {
    return {
        async getCatalog(principal: RequestPrincipal, selection?: CanonicalChatModelSelection): Promise<CanonicalProviderCatalog> {
            const catalog = await base.getCatalog(principal, selection?.instanceId === 'matrix_chatgpt_plan' ? undefined : selection);
            let source;
            try {
                source = await authority.observe(principal.userId);
            }
            catch (error) {
                if (error instanceof ChatGptPlanPeerError && error.code === 'forbidden')
                    return catalog;
                throw error;
            }
            const available = source.availability === 'available' && source.authorization.enabled && Boolean(source.accountId);
            const revision = `plan_${createHash('sha256').update(JSON.stringify({ base: catalog.revision, source })).digest('hex').slice(0, 32)}`;
            const selectionOptions = source.accountId ? [{ id: 'accountId', value: source.accountId }, { id: 'grantRevision', value: String(source.authorization.revision) }] : [];
            const instance: CanonicalProviderInstanceDescriptor = {
                id: 'matrix_chatgpt_plan', driverKind: 'matrix_bot', displayName: 'ChatGPT subscription',
                availability: available ? 'available' : 'unavailable', workspaceRequirement: 'none', catalogRevision: revision,
                models: available ? source.models.slice(0, 64).map(m => ({ ...m, availability: 'available', capabilities: ['tools'], supportsToolUse: true, supportsVision: false })) : [],
                options: selectionOptions.map(o => ({ id: o.id, label: o.id === 'accountId' ? 'Account' : 'Authorization', kind: 'enum', values: [{ value: o.value, label: o.id === 'accountId' ? 'Connected account' : 'Current permission' }], defaultValue: o.value, placement: 'advanced' })),
                skills: [], commands: [], setupActions: [],
                supports: { rootChat: false, resume: false, cancellation: true, steering: 'same_run', attachments: [], tools: [], approvals: false,
                    userInput: false, worktrees: 'none', resources: [], interactionModes: ['default'], permissionModes: ['default'] },
                ...(available && source.models[0] ? { defaultSelection: { instanceId: 'matrix_chatgpt_plan', model: source.models[0].id, options: selectionOptions } } : {}),
            };
            return { ...catalog, revision, drivers: catalog.drivers.some(d => d.kind === 'matrix_bot') ? catalog.drivers : [...catalog.drivers, MATRIX_BOT_DRIVER],
                instances: [...catalog.instances.filter(i => i.id !== instance.id).map(i => ({ ...i, catalogRevision: revision })), instance] };
        },
    };
}
