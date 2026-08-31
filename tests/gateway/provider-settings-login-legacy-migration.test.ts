import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProviderTerminalLoginCoordinator,
} from "../../packages/gateway/src/ai-providers/provider-terminal-login-coordinator.js";

describe("provider terminal login legacy migration", () => {
  let homePath: string;
  const now = new Date("2026-08-30T12:00:00.000Z");
  const sessions = new Set<string>();
  const registry = {
    get: vi.fn(async (name: string) => {
      if (!sessions.has(name)) throw Object.assign(new Error("missing"), { code: "session_not_found" });
      return { name };
    }),
    create: vi.fn(async (input: { name: string }) => {
      sessions.add(input.name);
      return { name: input.name };
    }),
    delete: vi.fn(async (name: string) => {
      sessions.delete(name);
    }),
    rename: vi.fn(async (name: string, nextName: string) => {
      if (!sessions.delete(name)) {
        throw Object.assign(new Error("missing"), { code: "session_not_found" });
      }
      if (sessions.has(nextName)) {
        sessions.add(name);
        throw Object.assign(new Error("exists"), { code: "session_exists" });
      }
      sessions.add(nextName);
      return { name: nextName };
    }),
  };
  const legacyInput = {
    mutation: {
      type: "start_login" as const,
      expectedRevision: 0,
      idempotencyKey: "login_legacy_original",
      harnessInstanceId: "harness_claude",
      accountId: "owner_anthropic",
      method: "terminal" as const,
    },
    harness: {
      id: "harness_claude",
      driverId: "claude_code",
      harness: "claude" as const,
      providerId: "anthropic",
      modelId: "claude-sonnet-5",
      installState: "installed" as const,
    },
  };

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "provider-terminal-login-legacy-"));
    sessions.clear();
    registry.get.mockClear();
    registry.create.mockClear();
    registry.delete.mockClear();
    registry.rename.mockClear();
  });

  afterEach(async () => {
    await rm(homePath, { recursive: true, force: true });
  });

  function coordinator() {
    return createProviderTerminalLoginCoordinator({
      homePath,
      registry,
      enabledHarnesses: ["claude"],
      now: () => now,
    });
  }

  async function seedLegacyLoginReceipt() {
    const hash = createHash("sha256").update(JSON.stringify(legacyInput)).digest("hex");
    const sessionName = `provider-login-claude-${hash.slice(0, 16)}`;
    const receipt = {
      key: legacyInput.mutation.idempotencyKey,
      payloadHash: hash,
      attempt: {
        id: `attempt_${hash.slice(0, 24)}`,
        harnessInstanceId: legacyInput.mutation.harnessInstanceId,
        accountId: legacyInput.mutation.accountId,
        method: legacyInput.mutation.method,
        state: "pending",
        action: { kind: "open_terminal", terminalSessionId: sessionName },
        expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
        safeFailure: null,
      },
    };
    await mkdir(join(homePath, "system/ai-providers"), { recursive: true });
    await writeFile(
      join(homePath, "system/ai-providers/login-receipts.json"),
      JSON.stringify({ version: 1, receipts: [receipt] }),
    );
    sessions.add(sessionName);
    return { receipt, sessionName };
  }

  it("migrates a live legacy receipt on a fresh-key retry without duplicating its terminal", async () => {
    const legacy = await seedLegacyLoginReceipt();

    const recovered = await coordinator().startLogin({
      ...legacyInput,
      mutation: {
        ...legacyInput.mutation,
        expectedRevision: 1,
        idempotencyKey: "login_legacy_fresh_key",
      },
    });

    expect(recovered.action).toMatchObject({
      kind: "open_terminal",
      terminalSessionId: expect.stringMatching(/^provider-login-[a-f0-9]{64}$/),
    });
    const recoveredSessionName = recovered.action.kind === "open_terminal"
      ? recovered.action.terminalSessionId
      : "";
    expect(registry.create).not.toHaveBeenCalled();
    expect(registry.rename).toHaveBeenCalledWith(legacy.sessionName, recoveredSessionName);
    expect(sessions).toEqual(new Set([recoveredSessionName]));

    const receipts = JSON.parse(await readFile(
      join(homePath, "system/ai-providers/login-receipts.json"),
      "utf8",
    )) as { receipts: Array<{ key: string; recoveryHash?: string }> };
    const upgraded = receipts.receipts.find((receipt) => receipt.key === legacy.receipt.key);
    expect(upgraded?.recoveryHash).toMatch(/^[a-f0-9]{64}$/);

    const recovery = JSON.parse(await readFile(
      join(homePath, "system/ai-providers/login-recovery.json"),
      "utf8",
    )) as { receipts: Array<{ key: string; recoveryHash?: string }> };
    expect(recovery.receipts).toContainEqual(expect.objectContaining({
      key: "login_legacy_fresh_key",
      recoveryHash: upgraded?.recoveryHash,
    }));
  });

  it("migrates a live legacy receipt across intervening settings revisions", async () => {
    const legacy = await seedLegacyLoginReceipt();

    const recovered = await coordinator().startLogin({
      ...legacyInput,
      mutation: {
        ...legacyInput.mutation,
        expectedRevision: 4,
        idempotencyKey: "login_legacy_later_retry",
      },
    });

    expect(recovered.action).toMatchObject({
      kind: "open_terminal",
      terminalSessionId: expect.stringMatching(/^provider-login-[a-f0-9]{64}$/),
    });
    const recoveredSessionName = recovered.action.kind === "open_terminal"
      ? recovered.action.terminalSessionId
      : "";
    expect(registry.create).not.toHaveBeenCalled();
    expect(registry.rename).toHaveBeenCalledWith(legacy.sessionName, recoveredSessionName);
    expect(sessions).toEqual(new Set([recoveredSessionName]));
  });

  it("renews an expired migrated legacy session without creating a canonical duplicate", async () => {
    const legacy = await seedLegacyLoginReceipt();
    let checkedAt = new Date(now);
    const login = createProviderTerminalLoginCoordinator({
      homePath,
      registry,
      enabledHarnesses: ["claude"],
      now: () => new Date(checkedAt),
    });
    const migrated = await login.startLogin({
      ...legacyInput,
      mutation: {
        ...legacyInput.mutation,
        expectedRevision: 1,
        idempotencyKey: "login_legacy_migrated_key",
      },
    });
    expect(migrated.action).toMatchObject({
      kind: "open_terminal",
      terminalSessionId: expect.stringMatching(/^provider-login-[a-f0-9]{64}$/),
    });
    const migratedSessionName = migrated.action.kind === "open_terminal"
      ? migrated.action.terminalSessionId
      : "";

    checkedAt = new Date(Date.parse(migrated.expiresAt) + 1);
    const renewed = await login.startLogin({
      ...legacyInput,
      mutation: {
        ...legacyInput.mutation,
        expectedRevision: 2,
        idempotencyKey: "login_legacy_after_expiry",
      },
    });

    expect(renewed).toMatchObject({
      state: "pending",
      action: { kind: "open_terminal", terminalSessionId: migratedSessionName },
    });
    expect(Date.parse(renewed.expiresAt) - checkedAt.getTime()).toBe(10 * 60_000);

    checkedAt = new Date(Date.parse(renewed.expiresAt) + 1);
    const sameKeyRenewal = await login.startLogin({
      ...legacyInput,
      mutation: {
        ...legacyInput.mutation,
        expectedRevision: 2,
        idempotencyKey: "login_legacy_after_expiry",
      },
    });
    expect(sameKeyRenewal.action).toEqual({
      kind: "open_terminal",
      terminalSessionId: migratedSessionName,
    });

    let latest = sameKeyRenewal;
    for (let revision = 3; revision <= 70; revision += 1) {
      checkedAt = new Date(Date.parse(latest.expiresAt) + 1);
      latest = await login.startLogin({
        ...legacyInput,
        mutation: {
          ...legacyInput.mutation,
          expectedRevision: revision,
          idempotencyKey: `login_legacy_after_expiry_${revision}`,
        },
      });
      expect(latest.action).toEqual({
        kind: "open_terminal",
        terminalSessionId: migratedSessionName,
      });
    }

    const receipts = JSON.parse(await readFile(
      join(homePath, "system/ai-providers/login-receipts.json"),
      "utf8",
    )) as { receipts: unknown[] };
    const recovery = JSON.parse(await readFile(
      join(homePath, "system/ai-providers/login-recovery.json"),
      "utf8",
    )) as { receipts: unknown[] };
    expect(receipts.receipts).toHaveLength(64);
    expect(recovery.receipts).toHaveLength(1);
    expect(registry.create).not.toHaveBeenCalled();
    expect(registry.delete).not.toHaveBeenCalled();
    expect(registry.rename).toHaveBeenCalledOnce();
    expect(sessions).toEqual(new Set([migratedSessionName]));
  });

  it("keeps a migrated legacy identity recoverable after both bounded receipt documents evict it", async () => {
    const legacy = await seedLegacyLoginReceipt();
    let checkedAt = new Date(now);
    const login = createProviderTerminalLoginCoordinator({
      homePath,
      registry,
      enabledHarnesses: ["claude"],
      now: () => new Date(checkedAt),
    });
    const migrated = await login.startLogin({
      ...legacyInput,
      mutation: {
        ...legacyInput.mutation,
        expectedRevision: 1,
        idempotencyKey: "login_legacy_migrated_durable",
      },
    });
    expect(migrated.action).toMatchObject({
      kind: "open_terminal",
      terminalSessionId: expect.stringMatching(/^provider-login-[a-f0-9]{64}$/),
    });
    const migratedSessionName = migrated.action.kind === "open_terminal"
      ? migrated.action.terminalSessionId
      : "";
    expect(migratedSessionName).not.toBe(legacy.sessionName);
    expect(registry.rename).toHaveBeenCalledWith(legacy.sessionName, migratedSessionName);
    expect(sessions).toContain(migratedSessionName);
    expect(sessions).not.toContain(legacy.sessionName);

    for (let index = 0; index < 65; index += 1) {
      await login.startLogin({
        ...legacyInput,
        mutation: {
          ...legacyInput.mutation,
          expectedRevision: index + 2,
          idempotencyKey: `login_eviction_${index}`,
          accountId: `owner_other_${index}`,
        },
      });
    }

    const receipts = await readFile(
      join(homePath, "system/ai-providers/login-receipts.json"),
      "utf8",
    );
    const recovery = await readFile(
      join(homePath, "system/ai-providers/login-recovery.json"),
      "utf8",
    );
    expect(receipts).not.toContain(migratedSessionName);
    expect(recovery).not.toContain(migratedSessionName);

    checkedAt = new Date(Date.parse(migrated.expiresAt) + 1);
    const createCountBeforeRetry = registry.create.mock.calls.length;
    const deleteCountBeforeRetry = registry.delete.mock.calls.length;
    const recovered = await login.startLogin({
      ...legacyInput,
      mutation: {
        ...legacyInput.mutation,
        expectedRevision: 67,
        idempotencyKey: "login_legacy_after_document_eviction",
      },
    });

    expect(recovered.action).toEqual({
      kind: "open_terminal",
      terminalSessionId: migratedSessionName,
    });
    expect(registry.create).toHaveBeenCalledTimes(createCountBeforeRetry);
    expect(registry.delete).toHaveBeenCalledTimes(deleteCountBeforeRetry);
    expect(sessions).toContain(migratedSessionName);
  });

  it.each([
    ["provider", { providerId: "openai", accountId: "owner_anthropic" }],
    ["account", { providerId: "anthropic", accountId: "owner_other" }],
  ])("does not migrate a legacy receipt across a changed %s identity", async (_field, changed) => {
    const legacy = await seedLegacyLoginReceipt();

    const attempt = await coordinator().startLogin({
      ...legacyInput,
      mutation: {
        ...legacyInput.mutation,
        expectedRevision: 1,
        idempotencyKey: "login_legacy_isolation_fresh",
        accountId: changed.accountId,
      },
      harness: { ...legacyInput.harness, providerId: changed.providerId },
    });

    expect(attempt.action).toMatchObject({ kind: "open_terminal" });
    expect(attempt.action.kind === "open_terminal" && attempt.action.terminalSessionId)
      .not.toBe(legacy.sessionName);
    expect(registry.create).toHaveBeenCalledOnce();
    expect(sessions).toContain(legacy.sessionName);
    expect(sessions.size).toBe(2);
  });
});
