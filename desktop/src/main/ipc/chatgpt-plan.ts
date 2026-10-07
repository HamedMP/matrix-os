import { CHATGPT_PLAN_INVOKE } from '../../shared/chatgpt-plan-ipc';
import type { createNativeChatgptPlanService } from '../chatgpt-plan/service';
type Service = ReturnType<typeof createNativeChatgptPlanService>;
interface Main {
    handle(channel: string, listener: (event: unknown, input: unknown) => Promise<unknown>): void;
}
/** This capability is main-frame only; apps/embeds never receive subscription authority. */
export function registerChatgptPlanIpc(ipc: Main, service: Service, isTrusted: (event: unknown) => boolean) {
    const required = [
        'status', 'connect', 'cancel', 'disconnect', 'refreshModels', 'setGrant'
    ] as const;
    if (!service || required.some(method => typeof service[method] !== 'function') || typeof isTrusted !== 'function')
        throw new Error('ChatGPT connection unavailable');
    for (const [channel, contract] of Object.entries(CHATGPT_PLAN_INVOKE)) {
        ipc.handle(channel, async (event, input) => {
            if (!isTrusted(event))
                throw new Error('invalid request');
            const parsed = contract.request.safeParse(input);
            if (!parsed.success)
                throw new Error('invalid request');
            try {
                const value = channel === 'chatgpt-plan:connect' ? await service.connect(CHATGPT_PLAN_INVOKE['chatgpt-plan:connect'].request.parse(parsed.data))
                    : channel === 'chatgpt-plan:set-grant' ? await service.setGrant(CHATGPT_PLAN_INVOKE['chatgpt-plan:set-grant'].request.parse(parsed.data))
                        : channel === 'chatgpt-plan:cancel' ? await service.cancel(parsed.data)
                            : channel === 'chatgpt-plan:disconnect' ? await service.disconnect(parsed.data)
                                : channel === 'chatgpt-plan:refresh-models' ? await service.refreshModels(parsed.data)
                                    : await service.status(parsed.data);
                return contract.response.parse(value);
            }
            catch (error: unknown) {
                console.warn('[chatgpt-plan] IPC operation failed', error instanceof Error ? error.name : 'UnknownError');
                throw new Error('internal error');
            }
        });
    }
}
