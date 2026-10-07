import type { CanonicalChatModelSelection, BotProviderConnection } from '@matrix-os/contracts';
import type { PiRuntimeBinding } from './runtime-registry.js';
import type { ResolvedBotRoute } from './route-resolver.js';
export const CHATGPT_PLAN_INSTANCE_ID = 'matrix_chatgpt_plan';
/** Registry-owned references, never credentials or worker-supplied account authority. */
export interface ChatGptPlanBinding {
    peerId: string;
    accountId: string;
    computerId: string;
    grantRevision: number;
}
/** An owner-local personal source using its own app registration and authenticated
 * native peer. Borrowed CLI credentials and self-declared eligibility flags are excluded. */
export interface ChatGptPlanAuthority {
    observe(ownerId: string): Promise<BotProviderConnection>;
    resolve(selection: CanonicalChatModelSelection, ownerId: string, requestClass: 'interactive' | 'background'): Promise<ResolvedBotRoute>;
    revalidate(binding: PiRuntimeBinding, signal: AbortSignal): Promise<boolean>;
    /** Local owner device performs inference. OAuth tokens never reach this gateway. */
    infer(binding: PiRuntimeBinding, body: string, signal: AbortSignal): Promise<{
        status: number;
        headers: Record<string, string>;
        body: string;
    }>;
}
