import { expect, it } from "vitest";
import { projectOpenClawNativeCatalog } from "../../packages/gateway/src/ai-providers/openclaw-native-catalog.js";
import type { AgentRuntimeSettingsSnapshot } from "../../packages/gateway/src/agent-config/service.js";
const now = new Date("2026-10-05T00:00:00Z");
it("projects observed OpenClaw API-key models as a harness source without claiming subscription access", () => {
  const snapshot = { runtime: { selected: "openclaw", options: [{ id: "openclaw", installState: "installed", health: "healthy" }] }, messaging: { runtime: "openclaw", provider: "anthropic", model: "native-model", configured: true },
    providers: [{ id: "anthropic", runtime: "openclaw", displayName: "Anthropic", authKind: "api_key", authStatus: { state: "ready", authenticated: true }, models: [{ id: "native-model", displayName: "Native model", available: true }] }] } as unknown as AgentRuntimeSettingsSnapshot;
  expect(projectOpenClawNativeCatalog(snapshot, now)).toMatchObject({ profiles: [{ harness: "openclaw", providerId: "anthropic", defaultModelId: "anthropic:native-model" }], failures: [] });
  snapshot.providers[0]!.authKind = "oauth_login";
  expect(projectOpenClawNativeCatalog(snapshot, now).profiles).toEqual([]);
});
