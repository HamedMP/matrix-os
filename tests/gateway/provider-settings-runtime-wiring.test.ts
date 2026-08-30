import { describe, expect, it, vi } from "vitest";
import { AiProviderSnapshotV3Schema } from "@matrix-os/contracts";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { initialProviderSettingsConfiguration } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import {
  PROVIDER_SETTINGS_NOW,
  providerSettingsCanonicalFixture,
} from "./provider-settings-test-support.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("provider settings runtime capability wiring", () => {
  it("wires the server-owned shell registry and canonical driver probes without lifecycle or route fiction", async () => {
    const source = await readFile(new URL("../../packages/gateway/src/server.ts", import.meta.url), "utf8");
    expect(source).toContain("createProviderDriverInventoryReader({");
    expect(source).toContain("detectAgentInstallations: agentCredentialLauncher.detectAgentInstallations");
    expect(source).toContain("runtimeSource: agentRuntimeServices.source");
    expect(source).toContain("createProviderTerminalLoginCoordinator({");
    expect(source).toContain("registry: zellijShellRegistry");
    expect(source).toContain("loginCoordinator: providerLoginCoordinator");
    expect(source).not.toContain("accountLifecycle: provider");
    expect(source).not.toContain("runtimeCoordinator: provider");
  });

  it("advertises terminal login when one projected harness is supported and rejects another harness", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "provider-runtime-capabilities-"));
    try {
      const base = providerSettingsCanonicalFixture();
      const canonical = AiProviderSnapshotV3Schema.parse({
        ...base,
        drivers: [...base.drivers, {
          id: "opencode",
          displayName: "OpenCode",
          kind: "cli",
          installState: "installed",
          health: "ready",
          capabilities: ["tools", "resume"],
          setupActions: ["open_terminal"],
        }],
        instances: [...base.instances, {
          id: "opencode_matrix",
          driverId: "opencode",
          vendor: "anthropic",
          accountId: null,
          accessSourceId: "matrix_included",
          label: "OpenCode",
          readiness: base.instances[0]!.readiness,
          capabilitySnapshot: ["tools", "resume"],
          modelIds: ["claude-sonnet-5"],
          defaultModelId: "claude-sonnet-5",
          catalogVersion: "catalog_1",
        }],
      });
      const login = {
        supportedMethods: vi.fn(({ harness }: { harness: string }) =>
          harness === "claude" ? ["terminal" as const] : []),
        startLogin: vi.fn(),
      };
      const store = new ProviderSettingsStore({
        homePath,
        providerSnapshotReader: { getSnapshot: async () => structuredClone(canonical) },
        loginCoordinator: login,
        now: () => PROVIDER_SETTINGS_NOW,
      });
      const snapshot = await store.getSnapshot();
      expect(snapshot.supportedActions).toEqual(["start_login"]);
      expect(snapshot.harnesses[0]?.loginMethods).toEqual(["terminal"]);
      expect(snapshot.harnesses[0]?.recommendedLoginMethod).toBe("terminal");
      expect(snapshot.harnesses.map((harness) => harness.harness)).toEqual(["claude", "opencode"]);
      expect(snapshot.harnesses[1]?.loginMethods).toEqual([]);
      expect(snapshot.harnesses[1]?.recommendedLoginMethod).toBeNull();

      await expect(store.mutate({
        type: "start_login",
        expectedRevision: 0,
        idempotencyKey: "unsupported_oauth_1",
        harnessInstanceId: "harness_kernel",
        accountId: null,
        method: "oauth",
      })).rejects.toMatchObject({ code: "invalid_request" });
      expect(login.startLogin).not.toHaveBeenCalled();

      await expect(store.mutate({
        type: "start_login",
        expectedRevision: 0,
        idempotencyKey: "unsupported_opencode_1",
        harnessInstanceId: "harness_opencode",
        accountId: null,
        method: "terminal",
      })).rejects.toMatchObject({ code: "invalid_request" });
      expect(login.startLogin).not.toHaveBeenCalled();
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("keeps real driver rows inventory-only until they have a canonical provider instance", () => {
    const base = providerSettingsCanonicalFixture();
    const config = initialProviderSettingsConfiguration(AiProviderSnapshotV3Schema.parse({
      ...base,
      drivers: [...base.drivers, {
        id: "codex",
        displayName: "Codex",
        kind: "cli",
        installState: "installed",
        health: "ready",
        capabilities: ["tools", "resume", "project_context"],
        setupActions: ["connect_account", "open_terminal"],
      }],
    }));
    expect(config.harnesses.map((harness) => harness.id)).toEqual(["harness_kernel"]);
  });

  it("returns an expired terminal attempt instead of reviving a stale durable receipt", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "provider-runtime-expiry-"));
    let now = PROVIDER_SETTINGS_NOW;
    try {
      const canonical = providerSettingsCanonicalFixture();
      const store = new ProviderSettingsStore({
        homePath,
        providerSnapshotReader: { getSnapshot: async () => ({
          ...structuredClone(canonical),
          refreshedAt: now.toISOString(),
        }) },
        loginCoordinator: {
          supportedMethods: () => ["terminal"],
          startLogin: async ({ mutation }) => ({
            id: "attempt_expiring_1",
            harnessInstanceId: mutation.harnessInstanceId,
            accountId: mutation.accountId,
            method: mutation.method,
            state: "pending",
            action: { kind: "open_terminal", terminalSessionId: "provider-login-claude-expiring" },
            expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
            safeFailure: null,
          }),
        },
        now: () => now,
      });
      const mutation = {
        type: "start_login" as const,
        expectedRevision: 0,
        idempotencyKey: "expiring_login_1",
        harnessInstanceId: "harness_kernel",
        accountId: null,
        method: "terminal" as const,
      };
      expect((await store.mutate(mutation)).kind).toBe("login_attempt");
      now = new Date(PROVIDER_SETTINGS_NOW.getTime() + 11 * 60_000);
      const duplicate = await store.mutate(mutation);
      expect(duplicate).toMatchObject({
        kind: "login_attempt",
        attempt: { state: "expired", action: { kind: "none" }, safeFailure: "expired" },
      });
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
