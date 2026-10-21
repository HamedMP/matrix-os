import { LOCAL_CHAT_IMPORT_INVOKE } from "../../shared/local-chat-import-ipc";
import type { createNativeChatImportService } from "../files/local-chat-import";
type Service = ReturnType<typeof createNativeChatImportService>;
interface Main {
    handle(channel: string, listener: (event: unknown, input: unknown) => Promise<unknown>): void;
}
/** Separate registration restricts transcript authority to trusted main-frame IPC. */
export function registerLocalChatImportIpc(ipc: Main, service: Service, isTrusted: (event: unknown) => boolean) {
    if (!service || typeof service.discover !== "function" || typeof service.prepare !== "function" || typeof service.reserve !== "function" || typeof service.select !== "function" || typeof service.apply !== "function" || typeof service.release !== "function" || typeof service.pause !== "function" || typeof isTrusted !== "function")
        throw new Error("Chat import unavailable");
    for (const [channel, contract] of Object.entries(LOCAL_CHAT_IMPORT_INVOKE)) {
        ipc.handle(channel, async (event, input) => {
            if (!isTrusted(event))
                throw new Error("invalid request");
            const parsed = contract.request.safeParse(input);
            if (!parsed.success)
                throw new Error("invalid request");
            try {
                const value = channel === "runtime:chat-import-discover" ? await service.discover(LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-discover"].request.parse(parsed.data))
                    : channel === "runtime:chat-import-reserve" ? service.reserve(LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-reserve"].request.parse(parsed.data))
                    : channel === "runtime:chat-import-prepare" ? await service.prepare(LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-prepare"].request.parse(parsed.data))
                    : channel === "runtime:chat-import-select" ? await service.select(LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-select"].request.parse(parsed.data))
                    : channel === "runtime:chat-import-apply" ? await service.apply(LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-apply"].request.parse(parsed.data))
                        : channel === "runtime:chat-import-release" ? service.release(LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-release"].request.parse(parsed.data)) : service.pause(LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-pause"].request.parse(parsed.data));
                const response = contract.response.safeParse(value);
                if (!response.success)
                    throw new Error("internal error");
                return response.data;
            }
            catch (error: unknown) {
                console.warn("[chat-import] IPC operation failed", error instanceof Error ? error.name : "UnknownError");
                throw new Error("internal error");
            }
        });
    }
}
