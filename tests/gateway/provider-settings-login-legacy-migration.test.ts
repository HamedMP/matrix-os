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

    expect(recovered.action).toEqual({
      kind: "open_terminal",
      terminalSessionId: legacy.sessionName,
    });
    expect(registry.create).not.toHaveBeenCalled();
    expect(sessions).toEqual(new Set([legacy.sessionName]));

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
