import { hasCompanyDriveMaterial } from "./drive-sharing-guard.js";
import { ChatDriveContextError } from "./drive-context.js";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";
import { loadGatewayCollaborationConfig } from "../collaboration/config.js";
import { createDriveContextRuntimeClient } from "../organization-drive/context-runtime-client.js";
import { createChatDriveContext, createAdmittedDriveRunLoader } from "./drive-context.js";
import { createChatDriveToolRoutes } from "./drive-context-routes.js";
/** Registration-time dependency resolution; server composition contains no drive authorization logic. */
export function createProductionChatDriveContext(options: {
    repository: ChatRepository | null;
    collaborationReady: boolean;
    env?: NodeJS.ProcessEnv;
}) {
    const env = options.env ?? process.env;
    const config = loadGatewayCollaborationConfig(env);
    let client: ReturnType<typeof createDriveContextRuntimeClient> | undefined;
    let service: ReturnType<typeof createChatDriveContext> | null = null;
    if (config?.ownerId && options.repository && options.collaborationReady) {
        try {
            const relayOrigin = config.relayOrigin;
            if (!relayOrigin || !config.clientOrigins.includes(relayOrigin))
                throw new Error("DriveRelayOriginUnavailable");
            client = createDriveContextRuntimeClient({ platformOrigin: config.platformBaseUrl, relayOrigin, runtimeId: config.runtimeId, ownerId: config.ownerId, serviceToken: config.serviceToken });
            service = createChatDriveContext({ ownerId: config.ownerId, repository: options.repository, client, loadRun: createAdmittedDriveRunLoader(options.repository) });
        }
        catch (error: unknown) {
            console.warn("[chat/drive-context] Runtime unavailable", error instanceof Error ? error.name : "UnknownError");
            client?.close();
            client = undefined;
        }
    }
    return { service, async assertChatReferenceAllowed(owner: ChatOwner, chatId: string) {
            // Referencing a Chat would otherwise copy excerpts without recording drive provenance.
            // Keep those references disabled until an audience policy can propagate that provenance.
            if (!options.repository)
                throw new ChatDriveContextError();
            const source = await options.repository.get(owner, chatId);
            if (!source || await hasCompanyDriveMaterial(options.repository.kysely, chatId))
                throw new ChatDriveContextError();
        }, routes: createChatDriveToolRoutes({ service }), close() { client?.close(); } };
}
