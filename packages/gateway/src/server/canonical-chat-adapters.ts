import { createGatewayClaudeChatRuntime } from "../chat/claude-native-chat-runtime.js";
import { createCanonicalCodingChatProviderAdapter } from "../chat/coding-provider-adapter.js";
import { createCustomMcpApprovalClient } from "../chat/custom-mcp-approval-client.js";
import type { CanonicalChatProviderAdapter } from "../chat/provider-adapter.js";
import type { CodingAgentProviderAdapter } from "../coding-agents/thread-store.js";
import { createInitialChatAdapters } from "./initial-chat-adapters.js";

export type GatewayNativeClaudeChatRuntime = ReturnType<typeof createGatewayClaudeChatRuntime>;

/** Compose provider adapters together, retaining the private Claude lifecycle owner. */
export function createGatewayChatAdapters(options: {
  initial: Parameters<typeof createInitialChatAdapters>[0];
  providers: CodingAgentProviderAdapter[];
  threads: Parameters<typeof createCanonicalCodingChatProviderAdapter>[0]["threads"] | undefined;
  claude: Pick<Parameters<typeof createGatewayClaudeChatRuntime>[0],
    "resolveCredentialLaunch" | "matrixMcpCapabilityIssuer" | "previewDriveClient">;
  customMcpApproval?: Parameters<typeof createCustomMcpApprovalClient>[0];
  botAdapter?: CanonicalChatProviderAdapter;
  managedBotAdapter?: CanonicalChatProviderAdapter;
}) {
  const adapters = createInitialChatAdapters(options.initial);
  const { homePath, toolOutputKey, routineCli, sharedBrowser, gatewayPort } = options.initial;
  let nativeClaude: GatewayNativeClaudeChatRuntime | null = null;
  if (options.providers.some(provider => provider.providerId === "claude")) {
    nativeClaude = createGatewayClaudeChatRuntime({
      homePath, credentialKey: toolOutputKey, ...options.claude,
      ...(routineCli ? { routineCli } : {}),
      ...(sharedBrowser ? { sharedBrowser, sharedBrowserGatewayPort: gatewayPort } : {}),
      customMcpApprovalClient: options.customMcpApproval
        ? createCustomMcpApprovalClient(options.customMcpApproval) : undefined,
    });
    adapters.push(nativeClaude.adapter);
  }
  if (options.threads) {
    for (const providerId of ["codex", "pi", "opencode"] as const) {
      if (!options.providers.some(provider => provider.providerId === providerId)) continue;
      adapters.push(createCanonicalCodingChatProviderAdapter({
        providerId, threads: options.threads, homePath, toolOutputKey,
        nativeInputProvider: options.providers.find(provider => provider.providerId === providerId),
        ...(routineCli ? { routineCli } : {}),
        ...(providerId === "codex" ? { ...(sharedBrowser ? { sharedBrowser } : {}), gatewayPort } : {}),
      }));
    }
  }
  if (options.botAdapter) adapters.push(options.botAdapter);
  if (options.managedBotAdapter) adapters.push(options.managedBotAdapter);
  return { adapters, nativeClaude };
}
