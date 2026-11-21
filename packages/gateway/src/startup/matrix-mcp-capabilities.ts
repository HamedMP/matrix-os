/**
 * Gateway wiring for run-scoped Matrix Core MCP capabilities (spec 2691).
 * One registry serves every harness, so Codex and OpenCode receive the same
 * run-scoped bearer Claude Code does.
 */
import { createMatrixMcpCapabilityRegistry } from "../chat/matrix-mcp-launch.js";

export function createGatewayMatrixMcpCapabilities(env: NodeJS.ProcessEnv) {
  const registry = createMatrixMcpCapabilityRegistry({
    // The VPS runner projects its single owner into both variables. If they
    // disagree, this runtime cannot safely bind a Chat owner to its broker.
    configuredOwnerId: env.MATRIX_CLERK_USER_ID === env.MATRIX_USER_ID
      ? env.MATRIX_CLERK_USER_ID
      : undefined,
    previewRuntime: env.MATRIX_PREVIEW_RUNTIME === "true",
  });
  const issueCoreMcpRunCapability = (ownerId: string, runId: string, scope: "call" | "discovery") => {
    const grant = registry.issue({ owner: { type: "personal", ownerId }, runId, scope });
    return grant ? { token: grant.token, scope, revoke: grant.revoke, renew: () => grant.renew?.() ?? false } : null;
  };
  return { registry, issueCoreMcpRunCapability };
}
