import { describe, expect, it, vi } from "vitest";
const client = vi.hoisted(() => ({ search: vi.fn(), read: vi.fn(), close: vi.fn() }));
const construct = vi.hoisted(() => vi.fn(() => client));
vi.mock("../../packages/gateway/src/organization-drive/context-runtime-client.js", () => ({ createDriveContextRuntimeClient: construct }));
import { createProductionChatDriveContext } from "../../packages/gateway/src/chat/drive-context-production.js";
const env = { MATRIX_RUNTIME_ID: "vps:fixture", MATRIX_USER_ID: "user_owner", PLATFORM_INTERNAL_URL: "https://internal.example", UPGRADE_TOKEN: "x".repeat(32), MATRIX_COLLABORATION_CLIENT_ORIGINS: "https://app.matrix-os.com" };
describe("registration-time company drive dependencies", () => {
    it("does not register a live service without owner storage and collaboration", () => {
        const missing = createProductionChatDriveContext({ repository: null, collaborationReady: true, env });
        expect(missing.service).toBeNull();
        expect(createProductionChatDriveContext({ repository: {} as never, collaborationReady: false, env }).service).toBeNull();
        expect(createProductionChatDriveContext({ repository: {} as never, collaborationReady: true, env: {} }).service).toBeNull();
        expect(construct).not.toHaveBeenCalled();
    });
    it("resolves separate trusted origins at registration and closes on shutdown", async () => {
        construct.mockClear();
        client.close.mockClear();
        const configured = createProductionChatDriveContext({ repository: {} as never, collaborationReady: true, env });
        expect(configured.service).not.toBeNull();
        expect(construct).toHaveBeenCalledWith(expect.objectContaining({ platformOrigin: env.PLATFORM_INTERNAL_URL, relayOrigin: "https://app.matrix-os.com", ownerId: env.MATRIX_USER_ID }));
        configured.close();
        expect(client.close).toHaveBeenCalledTimes(1);
        const mismatch = createProductionChatDriveContext({ repository: {} as never, collaborationReady: true, env: { ...env, COLLABORATION_RELAY_ORIGIN: "https://unexpected.example" } });
        expect(mismatch.service).toBeNull();
        expect(construct).toHaveBeenCalledTimes(1);
    });
    it("stays live on a production computer, where provisioning writes no client origins", () => {
        // The relay origin is itself the default client origin, so drive context no longer
        // disables itself on every production home for want of MATRIX_COLLABORATION_CLIENT_ORIGINS.
        construct.mockClear();
        const { MATRIX_COLLABORATION_CLIENT_ORIGINS: _unset, ...production } = env;
        const live = createProductionChatDriveContext({ repository: {} as never, collaborationReady: true, env: production });
        expect(live.service).not.toBeNull();
        expect(construct).toHaveBeenCalledWith(expect.objectContaining({ relayOrigin: "https://app.matrix-os.com" }));
        live.close();
    });
});
