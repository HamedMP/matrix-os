import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { IsolatedChatEnvelope } from "@matrix-os/contracts";
import { createCanonicalPhaseDiscovery } from "../../packages/gateway/src/server/canonical-phase-discovery.js";

import { readReleaseInfo } from "../../packages/gateway/src/system-info.js";
vi.mock("../../packages/gateway/src/system-info.js", () => ({ readReleaseInfo: vi.fn(() => undefined) }));
afterEach(() => { vi.unstubAllEnvs(); vi.mocked(readReleaseInfo).mockReset(); });

const token = "fixture-runtime-credential", at = new Date("2026-10-11T00:00:00.000Z");
const phase: IsolatedChatEnvelope = { phaseId: "phase_discovery", ownerId: "fixture_owner", machineId: "fixture_machine", runtimeSlot: "primary",
  runtimeTokenEpoch: 1, runtimeCredentialSha256: createHash("sha256").update(token).digest("hex"), sourceSha: "a".repeat(40),
  chatId: "chat_discovery", modelId: "@cf/zai-org/glm-5.3-flash", startsAt: at.toISOString(), expiresAt: "2026-10-11T00:10:00.000Z",
  target: { kind: "canonical_bot", botId: "bot_discovery1", recipeRef: { recipeId: "matrix-bot", version: "1.0.0" } } };
it("disabled funded config still scopes canonical UI reads from trusted server phase configuration", () => {
  const env = { MATRIX_ISOLATED_CHAT_ENVELOPE: JSON.stringify(phase), MATRIX_FUNDED_AI_ENABLED: "false", MATRIX_MACHINE_ID: phase.machineId,
    MATRIX_RUNTIME_SLOT: phase.runtimeSlot, MATRIX_RUNTIME_TOKEN_EPOCH: "1", MATRIX_FUNDED_AI_RUNTIME_TOKEN: token };
  const scope = createCanonicalPhaseDiscovery(undefined, phase.ownerId, { env, sourceSha: () => phase.sourceSha, now: () => at });
  expect(scope.canonical).toBe(true); expect(scope.observationScope({ userId: phase.ownerId })).toBe("canonical_matrix");
  env.MATRIX_RUNTIME_TOKEN_EPOCH = "2";
  expect(() => scope.observationScope()).toThrow("Matrix AI route readiness unavailable");
});
it("malformed server phase cannot disable the scope", () => {
  expect(() => createCanonicalPhaseDiscovery(undefined, phase.ownerId, { env: { MATRIX_ISOLATED_CHAT_ENVELOPE: "{}" } })).toThrow();
});
it("absent phase leaves normal discovery unchanged", () => {
  const scope = createCanonicalPhaseDiscovery(undefined, undefined, { env: {} });
  expect(scope.canonical).toBe(false); expect(scope.observationScope()).toBeUndefined();
});

it("missing actual host facts and installed provenance refuse scope without fallback", () => {
  const scope = createCanonicalPhaseDiscovery(undefined, undefined, { env: { MATRIX_ISOLATED_CHAT_ENVELOPE: JSON.stringify(phase) }, now: () => at });
  expect(() => scope.observationScope()).toThrow("Matrix AI route readiness unavailable");
});
it("configured runtime phase takes precedence and requires its actual build source", () => {
  const env = { MATRIX_MACHINE_ID: phase.machineId, MATRIX_RUNTIME_SLOT: phase.runtimeSlot, MATRIX_RUNTIME_TOKEN_EPOCH: "1", MATRIX_FUNDED_AI_RUNTIME_TOKEN: token, MATRIX_BUILD_SHA: phase.sourceSha };
  const config = { isolatedChat: phase, identity: { ownerId: phase.ownerId, machineId: phase.machineId, runtimeSlot: phase.runtimeSlot }, runtimeAuthToken: token,
    issueUrl: "https://platform.test/issue", fundingSummaryUrl: "https://platform.test/summary", routeReadinessUrl: "https://platform.test/readiness", relayBaseUrl: "https://relay.test", maxRunMs: 600000, requestTimeoutMs: 5000 };
  const scope = createCanonicalPhaseDiscovery(config, phase.ownerId, { env, now: () => at });
  expect(scope.observationScope()).toBe("canonical_matrix");
  env.MATRIX_BUILD_SHA = "b".repeat(40);
  expect(() => scope.observationScope()).toThrow();
  vi.mocked(readReleaseInfo).mockReturnValue({ gitCommit: phase.sourceSha } as never);
  expect(scope.observationScope()).toBe("canonical_matrix");
});
it("default server composition reads current environment facts on each request", () => {
  const current = { ...phase, startsAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
  for (const [name, value] of Object.entries({ MATRIX_ISOLATED_CHAT_ENVELOPE: JSON.stringify(current), MATRIX_MACHINE_ID: phase.machineId,
    MATRIX_RUNTIME_SLOT: phase.runtimeSlot, MATRIX_RUNTIME_TOKEN_EPOCH: "1", MATRIX_FUNDED_AI_RUNTIME_TOKEN: token, MATRIX_BUILD_SHA: phase.sourceSha })) vi.stubEnv(name, value);
  const scope = createCanonicalPhaseDiscovery(undefined, phase.ownerId);
  expect(scope.observationScope()).toBe("canonical_matrix");
  vi.stubEnv("MATRIX_MACHINE_ID", "other_machine"); expect(() => scope.observationScope()).toThrow();
});
