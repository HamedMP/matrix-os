import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProviderTerminalLoginCoordinator,
} from "../../packages/gateway/src/ai-providers/provider-terminal-login-coordinator.js";

describe("provider terminal login coordinator", () => {
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

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "provider-terminal-login-"));
    sessions.clear();
    registry.get.mockClear();
    registry.create.mockClear();
    registry.delete.mockClear();
  });

  afterEach(async () => {
    await rm(homePath, { recursive: true, force: true });
  });

  function coordinator(enabledHarnesses: Array<"codex" | "claude"> = ["codex", "claude"]) {
    return createProviderTerminalLoginCoordinator({
      homePath,
      registry,
      enabledHarnesses,
      now: () => now,
    });
  }

  it("creates a visible canonical session with the allowlisted Codex device-login command", async () => {
    const login = coordinator();
    expect(login.supportedMethods({
      id: "harness_codex",
      driverId: "codex",
      harness: "codex",
      installState: "installed",
    })).toEqual(["terminal"]);

    const attempt = await login.startLogin({
      mutation: {
        type: "start_login",
        expectedRevision: 0,
        idempotencyKey: "login_codex_1",
        harnessInstanceId: "harness_codex",
        accountId: null,
        method: "terminal",
      },
      harness: {
        id: "harness_codex",
        driverId: "codex",
        harness: "codex",
        providerId: "openai",
        modelId: "gpt-5",
        installState: "installed",
      },
    });

    expect(attempt).toMatchObject({
      harnessInstanceId: "harness_codex",
      method: "terminal",
      state: "pending",
      action: { kind: "open_terminal" },
      safeFailure: null,
    });
    expect(Date.parse(attempt.expiresAt) - now.getTime()).toBe(10 * 60_000);
    expect(registry.create).toHaveBeenCalledWith(expect.objectContaining({
      name: attempt.action.kind === "open_terminal" ? attempt.action.terminalSessionId : "",
      cwd: "~",
      agent: "codex",
      exclusive: false,
      cmd: "sh -lc 'export MATRIX_NODE_PREFIX=\"${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}\"; export PATH=\"$MATRIX_NODE_PREFIX/bin:$PATH\"; codex login --device-auth'",
    }));
  });

  it("supports only installed, server-enabled Codex and Claude terminal login", () => {
    const login = coordinator(["claude"]);
    expect(login.supportedMethods({
      id: "harness_kernel",
      driverId: "kernel",
      harness: "claude",
      installState: "installed",
    })).toEqual([]);
    expect(login.supportedMethods({
      id: "harness_kernel",
      driverId: "claude_code",
      harness: "claude",
      installState: "installed",
    })).toEqual(["terminal"]);
    expect(login.supportedMethods({
      id: "harness_codex",
      driverId: "codex",
      harness: "codex",
      installState: "installed",
    })).toEqual([]);
    expect(login.supportedMethods({
      id: "harness_claude",
      driverId: "claude_code",
      harness: "claude",
      installState: "missing",
    })).toEqual([]);
    expect(login.supportedMethods({
      id: "harness_opencode",
      driverId: "opencode",
      harness: "opencode",
      installState: "installed",
    })).toEqual([]);
  });

  it("refuses to launch a configured harness when the canonical CLI driver is not installed", async () => {
    const login = coordinator(["claude"]);
    await expect(login.startLogin({
      mutation: {
        type: "start_login",
        expectedRevision: 0,
        idempotencyKey: "missing_claude_1",
        harnessInstanceId: "harness_kernel",
        accountId: null,
        method: "terminal",
      },
      harness: {
        id: "harness_kernel",
        driverId: "claude_code",
        harness: "claude",
        providerId: "anthropic",
        modelId: "claude-sonnet-5",
        installState: "missing",
      },
    })).rejects.toMatchObject({ code: "lifecycle_unavailable" });
    expect(registry.create).not.toHaveBeenCalled();
  });

  it("durably deduplicates a login key and adopts the same real session after restart", async () => {
    const input = {
      mutation: {
        type: "start_login" as const,
        expectedRevision: 0,
        idempotencyKey: "login_claude_1",
        harnessInstanceId: "harness_kernel",
        accountId: null,
        method: "terminal" as const,
      },
      harness: {
        id: "harness_kernel",
        driverId: "claude_code",
        harness: "claude" as const,
        providerId: "anthropic",
        modelId: "claude-sonnet-5",
        installState: "installed" as const,
      },
    };
    const first = await coordinator().startLogin(input);
    const second = await coordinator().startLogin(input);
    expect(second).toEqual(first);
    expect(registry.create).toHaveBeenCalledOnce();
    const receipts = await readFile(join(homePath, "system/ai-providers/login-receipts.json"), "utf8");
    expect(receipts).toContain("login_claude_1");
    expect(receipts).not.toMatch(/token|secret|apiKey/i);
  });

  it("rejects unsupported methods and idempotency-key payload conflicts before launch", async () => {
    const login = coordinator();
    const base = {
      mutation: {
        type: "start_login" as const,
        expectedRevision: 0,
        idempotencyKey: "login_conflict_1",
        harnessInstanceId: "harness_kernel",
        accountId: null,
        method: "terminal" as const,
      },
      harness: {
        id: "harness_kernel",
        driverId: "claude_code",
        harness: "claude" as const,
        providerId: "anthropic",
        modelId: "claude-sonnet-5",
        installState: "installed" as const,
      },
    };
    await login.startLogin(base);
    await expect(login.startLogin({
      ...base,
      mutation: { ...base.mutation, harnessInstanceId: "harness_other" },
      harness: { ...base.harness, id: "harness_other" },
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(login.startLogin({
      ...base,
      mutation: { ...base.mutation, idempotencyKey: "login_oauth_1", method: "oauth" },
    })).rejects.toMatchObject({ code: "lifecycle_unavailable" });
    expect(registry.create).toHaveBeenCalledOnce();
  });

  it("deletes a newly-created login session when receipt persistence fails", async () => {
    const persistReceipt = vi.fn(async () => {
      throw new Error("disk unavailable");
    });
    const login = createProviderTerminalLoginCoordinator({
      homePath,
      registry,
      enabledHarnesses: ["claude"],
      now: () => now,
      persistReceipt,
    });
    await expect(login.startLogin({
      mutation: {
        type: "start_login",
        expectedRevision: 0,
        idempotencyKey: "login_persist_failure_1",
        harnessInstanceId: "harness_claude",
        accountId: null,
        method: "terminal",
      },
      harness: {
        id: "harness_claude",
        driverId: "claude_code",
        harness: "claude",
        providerId: "anthropic",
        modelId: "claude-sonnet-5",
        installState: "installed",
      },
    })).rejects.toMatchObject({ code: "lifecycle_unavailable" });
    expect(registry.delete).toHaveBeenCalledWith(expect.stringMatching(/^provider-login-[a-f0-9]{24}$/), { force: true });
    expect(sessions.size).toBe(0);
  });

  it("recovers an orphan after receipt and deletion failures without launching a changed retry", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const persistReceipt = vi.fn(async () => {
      throw new Error("disk unavailable with secret-provider-token");
    });
    registry.delete.mockRejectedValueOnce(new Error("delete failed with secret-provider-token"));
    const input = {
      mutation: {
        type: "start_login" as const,
        expectedRevision: 0,
        idempotencyKey: "login_orphan_recovery_1",
        harnessInstanceId: "harness_claude",
        accountId: null,
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
    const failed = createProviderTerminalLoginCoordinator({
      homePath,
      registry,
      enabledHarnesses: ["claude"],
      now: () => now,
      persistReceipt,
    });

    await expect(failed.startLogin(input)).rejects.toMatchObject({ code: "lifecycle_unavailable" });
    expect(sessions.size).toBe(1);
    expect(registry.create).toHaveBeenCalledOnce();
    const orphanName = [...sessions][0];
    expect(orphanName).toMatch(/^provider-login-[a-f0-9]{24}$/);

    const recovery = await readFile(join(homePath, "system/ai-providers/login-recovery.json"), "utf8");
    expect(recovery).toContain("login_orphan_recovery_1");
    expect(recovery).toContain(orphanName);
    expect(recovery).not.toMatch(/secret-provider-token|sh -lc|claude-sonnet-5/i);
    expect(JSON.stringify(warning.mock.calls)).not.toContain("secret-provider-token");

    const restarted = coordinator(["claude"]);
    await expect(restarted.startLogin({
      ...input,
      harness: { ...input.harness, modelId: "claude-opus-5" },
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(registry.create).toHaveBeenCalledOnce();

    const recovered = await restarted.startLogin(input);
    expect(recovered.action).toEqual({ kind: "open_terminal", terminalSessionId: orphanName });
    expect(registry.create).toHaveBeenCalledOnce();
    expect(sessions).toEqual(new Set([orphanName]));
  });

  it("adopts an orphan on a fresh-key retry without launching another login", async () => {
    const persistReceipt = vi.fn(async () => {
      throw new Error("disk unavailable");
    });
    registry.delete.mockRejectedValueOnce(new Error("delete unavailable"));
    const input = {
      mutation: {
        type: "start_login" as const,
        expectedRevision: 0,
        idempotencyKey: "login_fresh_key_original",
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
    const failed = createProviderTerminalLoginCoordinator({
      homePath,
      registry,
      enabledHarnesses: ["claude"],
      now: () => now,
      persistReceipt,
    });

    await expect(failed.startLogin(input)).rejects.toMatchObject({ code: "lifecycle_unavailable" });
    const orphanName = [...sessions][0]!;
    const recovered = await failed.startLogin({
      ...input,
      mutation: {
        ...input.mutation,
        expectedRevision: 1,
        idempotencyKey: "login_fresh_key_retry",
      },
    });

    expect(recovered.action).toEqual({ kind: "open_terminal", terminalSessionId: orphanName });
    expect(registry.create).toHaveBeenCalledOnce();
    expect(sessions).toEqual(new Set([orphanName]));
  });

  it("recovers a fresh-key orphan after restart and remembers its conflict hash", async () => {
    const persistReceipt = vi.fn(async () => {
      throw new Error("disk unavailable with secret-provider-token");
    });
    registry.delete.mockRejectedValueOnce(new Error("delete failed with secret-provider-token"));
    const input = {
      mutation: {
        type: "start_login" as const,
        expectedRevision: 0,
        idempotencyKey: "login_restart_original",
        harnessInstanceId: "harness_claude",
        accountId: null,
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
    const failed = createProviderTerminalLoginCoordinator({
      homePath,
      registry,
      enabledHarnesses: ["claude"],
      now: () => now,
      persistReceipt,
    });
    await expect(failed.startLogin(input)).rejects.toMatchObject({ code: "lifecycle_unavailable" });
    const orphanName = [...sessions][0]!;

    const restarted = coordinator(["claude"]);
    const freshInput = {
      ...input,
      mutation: {
        ...input.mutation,
        expectedRevision: 2,
        idempotencyKey: "login_restart_fresh_key",
      },
    };
    const recovered = await restarted.startLogin(freshInput);
    expect(recovered.action).toEqual({ kind: "open_terminal", terminalSessionId: orphanName });
    expect(registry.create).toHaveBeenCalledOnce();
    expect(sessions).toEqual(new Set([orphanName]));

    await expect(restarted.startLogin({
      ...freshInput,
      harness: { ...freshInput.harness, modelId: "claude-opus-5" },
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(registry.create).toHaveBeenCalledOnce();

    const recovery = await readFile(join(homePath, "system/ai-providers/login-recovery.json"), "utf8");
    expect(recovery).toContain("login_restart_fresh_key");
    expect(recovery).not.toMatch(/secret-provider-token|sh -lc|claude-sonnet-5/i);
  });
});
