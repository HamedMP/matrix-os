import { createHermesSettingsConnection } from "../ai-providers/hermes-settings-auth.js";
import { createOwnerAnthropicKeySaver } from "../ai-providers/owner-anthropic-key.js";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import type { AiProviderSnapshotV3 } from "@matrix-os/contracts";
import type { TerminalRuntimeSocketClient } from "@matrix-os/terminal-runtime";
import type { ProviderSettingsStoreWriter } from "../ai-providers/provider-settings-store.js";
import type { NativeProviderProfileGuard } from "../ai-providers/native-provider-profile-guard.js";
import { buildAgentRuntimeEnvironment as buildSettingsAccountEnvironment } from "../agent-launcher.js";
import { discoverPiSettingsAuth, createPiSettingsConnection } from "../ai-providers/pi-settings-auth.js";
import { createOpenClawSettingsConnection } from "../ai-providers/openclaw-settings-auth.js";
import { openOpenCodeAuthSession, createOpenCodeSettingsConnection, enableOpenCodeConnectedRoute, enableNativeSettingsConnectedRoute } from "../ai-providers/opencode-settings-auth.js";
import { createClaudeSettingsLogin } from "../ai-providers/provider-workflow-browser.js";
import { createCodexSettingsLogin } from "../ai-providers/provider-workflow-codex-login.js";
import { createNativeProviderWorkflowAdapters, closeNativeProviderWorkflowConnections } from "../ai-providers/provider-workflow-native.js";
import { createCodexKeySaver, createProviderKeyVerifier } from "../ai-providers/provider-workflow-key.js";
import { registerProviderWorkflowRuntime } from "./provider-workflow-runtime.js";
import { createGenericNativeWriter, guardGenericNativeKeys } from "../ai-providers/generic-native-writer.js";

/** Owner-native workflow composition and resource ownership, shared by production and wiring tests. */
export async function createNativeProviderWorkflowRuntime(options: {
  app: Hono;
  homePath: string;
  ownerId: string | null;
  getPrincipal: (context: Context) => { userId: string } | null;
  store: ProviderSettingsStoreWriter;
  terminal: Pick<TerminalRuntimeSocketClient, "ensureWorkspace" | "createTab" | "terminateTab" | "attach" | "listWorkspaces">;
  profileGuard: NativeProviderProfileGuard;
  inventory: () => Promise<Pick<AiProviderSnapshotV3, "drivers">>;
}) {
  const { app, homePath, store: workflowStore, terminal: terminalWorkspaceRuntime, profileGuard: nativeProviderProfileGuard } = options;
  const genericWriter = createGenericNativeWriter(homePath);
  const opencodeSettingsConnection = guardGenericNativeKeys(genericWriter, "opencode", createOpenCodeSettingsConnection({
    session: () => openOpenCodeAuthSession({ command: join(process.env.MATRIX_NODE_PREFIX ?? "/opt/matrix/runtime/node", "bin/opencode"), cwd: homePath, env: buildSettingsAccountEnvironment(homePath) }),
    enableConnected: (id, key) => enableOpenCodeConnectedRoute(workflowStore, id, key),
    enableProviderConnected: (id, provider, key) => enableNativeSettingsConnectedRoute(workflowStore, id, "opencode", provider, key),
  }));
  const piSettingsConnection = guardGenericNativeKeys(genericWriter, "pi", createPiSettingsConnection({
    discover: () => discoverPiSettingsAuth({ homePath, runtimePrefix: process.env.MATRIX_NODE_PREFIX, env: buildSettingsAccountEnvironment(homePath) }),
    enableConnected: (id, provider, key) => enableNativeSettingsConnectedRoute(workflowStore, id, "pi", provider, key),
  }));
  const openclawSettingsConnection = guardGenericNativeKeys(genericWriter, "openclaw", createOpenClawSettingsConnection({
    command: join(process.env.MATRIX_NODE_PREFIX ?? "/opt/matrix/runtime/node", "bin/openclaw"), cwd: homePath,
    env: { ...buildSettingsAccountEnvironment(homePath), OPENCLAW_STATE_DIR: join(homePath, ".openclaw"), OPENCLAW_CONFIG_PATH: join(homePath, ".openclaw/openclaw.json") },
    enableConnected: (id, key) => enableNativeSettingsConnectedRoute(workflowStore, id, "openclaw", "openai", key),
    enableProviderConnected: (id, provider, key) => enableNativeSettingsConnectedRoute(workflowStore, id, "openclaw", provider, key),
  }));
  const hermesSettingsConnection = guardGenericNativeKeys(genericWriter, "hermes", createHermesSettingsConnection({ homePath,
    enableConnected: (id, provider, key) => enableNativeSettingsConnectedRoute(workflowStore, id, "hermes", provider, key),
  }));
  const providerWorkflowLifecycle = await registerProviderWorkflowRuntime({
    app,
    ownerId: options.ownerId,
    getPrincipal: options.getPrincipal,
    createAdapters: () => createNativeProviderWorkflowAdapters({
      store: workflowStore, terminal: terminalWorkspaceRuntime, profileGuard: nativeProviderProfileGuard,
      genericWriter,
      hermesConnection: hermesSettingsConnection,
      claudeBrowserLogin: createClaudeSettingsLogin({ command: "claude", cwd: homePath, env: buildSettingsAccountEnvironment(homePath), acquire: () => nativeProviderProfileGuard.acquire("claude", { kind: "write", durable: true }) }),
      codexSettingsLogin: createCodexSettingsLogin({ command: join(process.env.MATRIX_NODE_PREFIX ?? "/opt/matrix/runtime/node", "bin/codex"), cwd: homePath,
        env: { ...buildSettingsAccountEnvironment(homePath), ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) }, acquire: () => nativeProviderProfileGuard.acquire("codex", { kind: "write", durable: true }) }),
      opencodeConnection: opencodeSettingsConnection,
      piConnection: piSettingsConnection,
      openclawConnection: openclawSettingsConnection,
      inventory: async () => (await options.inventory()).drivers,
      verifyKeys: { claude: createProviderKeyVerifier({ providerId: "anthropic", profileGuard: nativeProviderProfileGuard, profile: "claude", save: createOwnerAnthropicKeySaver({ homePath }) }), codex: createProviderKeyVerifier({ providerId: "openai", profileGuard: nativeProviderProfileGuard, profile: "codex", save: createCodexKeySaver({ homePath }) }) },
    }),
  });
  return { close: () => closeNativeProviderWorkflowConnections([
    () => providerWorkflowLifecycle.close(),
    () => opencodeSettingsConnection.close(),
    () => piSettingsConnection.close(),
    () => openclawSettingsConnection.close(),
    () => hermesSettingsConnection.close(),
  ]) };
}
