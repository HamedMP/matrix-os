import { generateAppText } from "@matrix-os/kernel";
import type { AppAiRouteSelection } from "@matrix-os/contracts";
import { buildKernelCredentialLaunch } from "../kernel-credentials.js";
import { buildPiChildEnvironment } from "../coding-agents/pi-process-environment.js";
import { createClaudeNativeAccountMetadataReader, type ClaudeNativeAccountMetadata } from "../ai-providers/claude-native-account-metadata.js";
import type { NativeProviderProfileGuard } from "../ai-providers/native-provider-profile-guard.js";
/** Borrow only the selected native Claude profile, while its owner writer lease is held. */
export async function generateClaudeProfileAppText(options: {
    homePath: string;
    route: AppAiRouteSelection;
    prompt: string;
    accountEmail: string;
    signal: AbortSignal;
    profileGuard: NativeProviderProfileGuard;
    revalidate: () => Promise<boolean>;
    observeAccount?: () => Promise<ClaudeNativeAccountMetadata | null>;
}) {
    if (options.route.accessSourceId !== "owner_claude_profile" || options.route.accountId === null)
        throw new Error("App AI profile unavailable");
    options.signal.throwIfAborted();
    const release = await options.profileGuard.acquire("claude", { kind: "write", durable: true });
    try {
        const env = buildPiChildEnvironment({ HOME: options.homePath });
        env.HOME = options.homePath;
        // This caller holds the profile writer lease. Its own bounded identity read
        // must not reject that lease as though it belonged to a competing writer.
        const observe = options.observeAccount ?? createClaudeNativeAccountMetadataReader({ executable: "claude", cwd: options.homePath, environment: env, assertProfileAvailable: async () => { options.signal.throwIfAborted(); } });
        const exactAccount = async () => {
            options.signal.throwIfAborted();
            const account = await observe();
            options.signal.throwIfAborted();
            return account?.authMethod === "terminal" && account.accountLabel === options.accountEmail
                && Date.parse(account.checkedAt) <= Date.now() && Date.parse(account.staleAfter) > Date.now();
        };
        if (!await options.revalidate() || !await exactAccount())
            throw new Error("App AI account changed");
        const launch = await buildKernelCredentialLaunch(options.homePath, env, "owner_claude_profile", undefined, { requestClass: "interactive" });
        if (!launch.env || launch.env.HOME !== options.homePath || launch.env.ANTHROPIC_API_KEY || launch.env.ANTHROPIC_AUTH_TOKEN || launch.env.CLAUDE_CODE_OAUTH_TOKEN || launch.env.CLAUDE_CONFIG_DIR)
            throw new Error("App AI profile unavailable");
        if (!await options.revalidate())
            throw new Error("App AI access revoked");
        const result = await generateAppText({ prompt: options.prompt, model: options.route.modelId, env: launch.env, signal: options.signal });
        if (!await options.revalidate() || !await exactAccount())
            throw new Error("App AI account changed");
        return result;
    }
    finally {
        await release();
    }
}
