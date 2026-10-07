import { createHash } from 'node:crypto';
import { MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID, MATRIX_CHATGPT_PLAN_INSTANCE_ID } from '@matrix-os/contracts';
import { MANAGED_PI_CHAT_SUPPORTS } from '../chat/managed-chat-catalog.js';
import type { CanonicalProviderCatalog, CanonicalProviderInstanceDescriptor, CanonicalChatModelSelection } from '@matrix-os/contracts';
import type { ChatProviderCatalogService } from '../chat/provider-catalog.js';
import type { RequestPrincipal } from '../request-principal.js';
import type { ChatGptPlanAuthority } from './chatgpt-plan.js';
import { ChatGptPlanPeerError } from './chatgpt-plan-peers.js';
import { MATRIX_BOT_DRIVER } from './provider-instance.js';
/** Project ordinary Pi Chat and recipe Bot routes from one owner-device observation. */
export function withChatGptPlanProviderInstance(base: Pick<ChatProviderCatalogService, 'getCatalog'>, authority: Pick<ChatGptPlanAuthority, 'observe'>, ordinaryChatAvailable: () => boolean = () => false): Pick<ChatProviderCatalogService, 'getCatalog'> {
    return {
        async getCatalog(principal: RequestPrincipal, selection?: CanonicalChatModelSelection): Promise<CanonicalProviderCatalog> {
            const catalog = await base.getCatalog(principal, selection?.instanceId === MATRIX_CHATGPT_PLAN_INSTANCE_ID ? undefined : selection);
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
            const chatRuntimeAvailable = ordinaryChatAvailable();
            const chatAvailable = available && chatRuntimeAvailable;
            const revision = `plan_${createHash('sha256').update(JSON.stringify({ base: catalog.revision, source, chatAvailable })).digest('hex').slice(0, 32)}`;
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
            const chat: CanonicalProviderInstanceDescriptor = { ...instance,
                id: MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID, driverKind: 'matrix_pi', displayName: 'Codex · ChatGPT subscription',
                workspaceRequirement: 'project_optional', supports: MANAGED_PI_CHAT_SUPPORTS,
                availability: chatAvailable ? 'available' : 'unavailable', models: chatAvailable ? instance.models : [],
                ...(!chatRuntimeAvailable ? { unavailabilityReason: 'runtime_unavailable' as const } : {}),
                ...(chatAvailable && instance.defaultSelection ? { defaultSelection: { ...instance.defaultSelection, instanceId: MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID } } : {}),
            };
            if (!chatAvailable) delete chat.defaultSelection;
            const drivers = [...catalog.drivers];
            if (!drivers.some(d => d.kind === 'matrix_bot')) drivers.push(MATRIX_BOT_DRIVER);
            if (!drivers.some(d => d.kind === 'matrix_pi')) drivers.push({ kind: 'matrix_pi', displayName: 'Pi', adapterVersion: '1.0.0', capabilityClass: 'system_agent' });
            return { ...catalog, revision, drivers,
                instances: [...catalog.instances.filter(i => i.id !== instance.id && i.id !== chat.id).map(i => ({ ...i, catalogRevision: revision })), instance, chat] };
        },
    };
}
