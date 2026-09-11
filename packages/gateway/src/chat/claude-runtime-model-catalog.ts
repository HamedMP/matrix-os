import { createHash } from "node:crypto";
import { readClaudeModelInventory } from "@matrix-os/kernel";
import { buildAgentLaunch } from "../agent-launcher.js";
import type { KernelCredentialLaunch } from "../kernel-credentials.js";
import { createClaudeModelCatalogSource } from "./claude-model-catalog.js";

export function createRuntimeClaudeModelCatalogSource(options: {
  homePath: string;
  resolveCredentialLaunch: () => Promise<KernelCredentialLaunch>;
  readInventory?: typeof readClaudeModelInventory;
}) {
  return createClaudeModelCatalogSource({
    resolveContext: async (signal) => {
      const launch = buildAgentLaunch({
        agent: "claude", cwd: options.homePath, runtimeHome: options.homePath,
        claudePermissionMode: "default",
        sandbox: { enabled: true, mode: "read-only", writableRoots: [] },
      });
      const credentials = await options.resolveCredentialLaunch();
      signal.throwIfAborted();
      // Match the actual adapter's credential environment and runtime HOME/PATH.
      const env = { ...(credentials.env ?? process.env), ...launch.env };
      const key = createHash("sha256").update(JSON.stringify([
        launch.command, launch.cwd, Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
      ])).digest("hex");
      const explicitCredential = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
      return {
        key,
        // Profile/keychain generation cannot be verified without inspecting
        // credential stores. Limit its cache to 5s, and discard on Refresh.
        retainOnRefresh: explicitCredential,
        maxAgeMs: explicitCredential ? 60_000 : 5_000,
        discover: (requestSignal) => (options.readInventory ?? readClaudeModelInventory)({
          executable: launch.command, cwd: launch.cwd, env, signal: requestSignal,
        }),
      };
    },
  });
}
