import { herdrControlParts } from "./fixtures/herdr-chat-control-parts.js";
import { expect, it, vi } from "vitest";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { createCodexMcpRunScope } from "../../packages/gateway/src/chat/codex-mcp-run-scope.js";
import { prepareCodexTerminalMcp } from "../../packages/gateway/src/coding-agents/codex-terminal-mcp-client.js";
import type { CanonicalProviderRunInput } from "../../packages/gateway/src/chat/provider-adapter.js";
it.each([false, true])(
  "does not replay an uncertain private MCP bind and confirms owned cleanup (revoked=%s)",
  async (revoked) => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "owner" }),
      sources = createCodexMcpRunScope({ issuer: registry, gatewayPort: 4000 });
    const source = sources.open({
      owner: { type: "personal", ownerId: "owner" },
      chatId: "chat_one",
      runId: "run_one",
      ownerSubmittedHerdrTurn: true as const,
      parts: herdrControlParts(),
      interactionMode: "default",
      permissionMode: "full_access",
      worktreeId: "wt_7777777777777777",
      executionRoot: "/isolated",
      signal: new AbortController().signal,
    } as CanonicalProviderRunInput)!;
    const prepareMatrixMcp = vi.fn(async () => {
        throw Error("Synthetic uncertain acknowledgement");
      }),
      stopSession = vi.fn(async () => ({ ok: true }));
    try {
      if (revoked) source.close();
      await expect(
        (async () =>
          source.withContext(() =>
            prepareCodexTerminalMcp({
              ownerId: "owner",
              sessionId: "sess_one",
              lease: source.lease,
              control: { prepareMatrixMcp } as never,
              runtime: { stopSession } as never,
              signal: new AbortController().signal,
            }),
          ))(),
      ).rejects.toThrow();
      expect(prepareMatrixMcp).toHaveBeenCalledTimes(revoked ? 0 : 1);
      expect(stopSession).toHaveBeenCalledTimes(revoked ? 0 : 1);
    } finally {
      source.close();
      registry.close();
    }
  },
);
