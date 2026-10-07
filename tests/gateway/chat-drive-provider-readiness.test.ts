import { describe, expect, it } from "vitest";
import type { AgentProviderSummary } from "@matrix-os/contracts";
import { createChatProviderCatalogService } from "../../packages/gateway/src/chat/provider-catalog.js";
const principal = { userId: "user_owner", source: "jwt" as const };
const providers: AgentProviderSummary[] = ["claude", "codex"].map(id => ({
    id, displayName: id, kind: id as "claude" | "codex", availability: "available",
    installStatus: "installed", authStatus: "authenticated", supportedModes: ["default"],
    defaultMode: "default", defaultModel: id === "claude" ? "claude-sonnet-5" : "gpt-5.4", setupActions: [],
}));
describe("company drive catalog readiness", () => {
    it("advertises live drive context only for a ready, executable Claude runtime", async () => {
        let ready = false;
        const service = createChatProviderCatalogService({
            codingProviders: { listProviders: async () => providers, invalidate() { } },
            agentRuntimeSource: async () => { throw new Error("No system runtime configured"); },
            executableDriverKinds: ["claude_code", "codex"], driveContextReady: () => ready,
        });
        const unavailable = await service.getCatalog(principal);
        expect(unavailable.instances.every(instance => !instance.supports.resources.includes("organization_drive"))).toBe(true);
        ready = true;
        const available = await service.getCatalog(principal);
        expect(available.instances.find(instance => instance.driverKind === "claude_code")?.supports.resources).toContain("organization_drive");
        expect(available.instances.filter(instance => instance.driverKind !== "claude_code").every(instance => !instance.supports.resources.includes("organization_drive"))).toBe(true);
        expect(available.revision).not.toBe(unavailable.revision);
        const notExecutable = createChatProviderCatalogService({
            codingProviders: { listProviders: async () => providers, invalidate() { } },
            agentRuntimeSource: async () => { throw new Error("No system runtime configured"); },
            executableDriverKinds: [], driveContextReady: () => true,
        });
        expect((await notExecutable.getCatalog(principal)).instances.every(instance => !instance.supports.resources.includes("organization_drive"))).toBe(true);
    });
});
