import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProviderCliAccountLifecycleCoordinator,
  createDefaultProviderCliAccountLifecycleCoordinator,
} from "../../packages/gateway/src/ai-providers/provider-cli-account-lifecycle.js";
import type {
  ProviderLifecycleAccount,
} from "../../packages/gateway/src/ai-providers/provider-settings-coordinators.js";

describe("provider CLI account lifecycle", () => {
  let homePath: string;
  const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
  const claudeAccount: ProviderLifecycleAccount = {
    id: "owner_anthropic",
    providerId: "anthropic",
    authMethod: "terminal",
    accessSourceId: "owner_anthropic_profile",
    driverId: "claude_code",
    harness: "claude",
    installState: "installed",
    authenticated: true,
    driverAccountCount: 1,
  };

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "provider-account-lifecycle-"));
    run.mockClear();
    vi.stubEnv("ANTHROPIC_API_KEY", "must-not-reach-logout");
    vi.stubEnv("CODEX_HOME", "/tmp/must-not-be-used");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(homePath, { recursive: true, force: true });
  });

  function coordinator(enabledDriverIds: Array<"codex" | "claude_code"> = ["codex", "claude_code"]) {
    return createProviderCliAccountLifecycleCoordinator({
      homePath,
      enabledDriverIds,
      run,
    });
  }

  it("derives default lifecycle drivers from the enabled harness set", () => {
    const lifecycle = createDefaultProviderCliAccountLifecycleCoordinator({
      homePath,
      enabledHarnesses: ["claude"],
      run,
    });
    expect(lifecycle.supportedActions(claudeAccount)).toEqual(["logout_account", "remove_account"]);
    expect(lifecycle.supportedActions({
      ...claudeAccount,
      id: "owner_openai",
      providerId: "openai",
      accessSourceId: "owner_openai_profile",
      driverId: "codex",
      harness: "codex",
      authMethod: "oauth",
    })).toEqual([]);
  });

  it("runs only the verified Claude logout command and durably deduplicates it", async () => {
    const lifecycle = coordinator();
    expect(lifecycle.supportedActions(claudeAccount)).toEqual(["logout_account", "remove_account"]);
    const input = {
      account: claudeAccount,
      idempotencyKey: "logout_claude_1",
    };
    await lifecycle.logout(input);
    await coordinator().logout({
      ...input,
      account: { ...input.account, authenticated: false, installState: "missing" },
    });

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith("claude", ["auth", "logout"], expect.objectContaining({
      cwd: homePath,
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
      env: expect.objectContaining({ HOME: homePath, MATRIX_HOME: homePath }),
    }));
    const commandOptions = run.mock.calls[0]![2];
    expect(commandOptions.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(commandOptions.env).not.toHaveProperty("CODEX_HOME");
    const receipts = JSON.parse(await readFile(
      join(homePath, "system/ai-providers/lifecycle-receipts.json"),
      "utf8",
    ));
    expect(receipts.receipts).toHaveLength(1);
    expect(receipts.receipts[0]).toMatchObject({ key: "logout_claude_1", state: "completed" });
    expect(JSON.stringify(receipts)).not.toMatch(/stdout|stderr|token|secret/i);
  });

  it("runs the verified Codex logout command for one exact installed CLI account", async () => {
    const lifecycle = coordinator();
    const account: ProviderLifecycleAccount = {
      ...claudeAccount,
      id: "owner_openai",
      providerId: "openai",
      authMethod: "oauth",
      accessSourceId: "owner_openai_profile",
      driverId: "codex",
      harness: "codex",
    };
    await lifecycle.remove({ account, idempotencyKey: "remove_codex_1" });
    expect(run).toHaveBeenCalledWith("codex", ["logout"], expect.any(Object));
  });

  it("rejects missing, mismatched, disabled, and ambiguous multi-account drivers", async () => {
    const lifecycle = coordinator(["claude_code"]);
    const unsupported = [
      { ...claudeAccount, installState: "missing" as const },
      { ...claudeAccount, driverId: "kernel" },
      { ...claudeAccount, providerId: "openai" },
      { ...claudeAccount, driverAccountCount: 2 },
      { ...claudeAccount, driverId: "codex", harness: "codex" as const, providerId: "openai" },
    ];
    for (const account of unsupported) {
      expect(lifecycle.supportedActions(account as ProviderLifecycleAccount)).toEqual([]);
      await expect(lifecycle.logout({
        account: account as ProviderLifecycleAccount,
        idempotencyKey: `unsupported_${unsupported.indexOf(account)}`,
      })).rejects.toMatchObject({ code: "lifecycle_unavailable" });
    }
    const disconnected = { ...claudeAccount, authenticated: false };
    expect(lifecycle.supportedActions(disconnected)).toEqual(["remove_account"]);
    await expect(lifecycle.logout({
      account: disconnected,
      idempotencyKey: "unsupported_disconnected_logout",
    })).rejects.toMatchObject({ code: "lifecycle_unavailable" });
    await lifecycle.remove({
      account: disconnected,
      idempotencyKey: "remove_disconnected_profile",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed on command errors and idempotency conflicts without exposing output", async () => {
    run.mockRejectedValueOnce(new Error("provider secret output"));
    const lifecycle = coordinator();
    await expect(lifecycle.logout({
      account: claudeAccount,
      idempotencyKey: "logout_failure_1",
    })).rejects.toMatchObject({ code: "lifecycle_unavailable", message: "lifecycle_unavailable" });
    await expect(lifecycle.logout({
      account: { ...claudeAccount, id: "owner_other" },
      idempotencyKey: "logout_failure_1",
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("does not rerun a command when a crash leaves a durable pending receipt", async () => {
    const lifecycle = coordinator();
    const input = { account: claudeAccount, idempotencyKey: "logout_pending_1" };
    await lifecycle.logout(input);
    const path = join(homePath, "system/ai-providers/lifecycle-receipts.json");
    const document = JSON.parse(await readFile(path, "utf8"));
    document.receipts[0].state = "pending";
    await writeFile(path, JSON.stringify(document), { mode: 0o600 });
    await expect(coordinator().logout(input))
      .rejects.toMatchObject({ code: "lifecycle_unavailable" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("bounds durable lifecycle receipts", async () => {
    const lifecycle = coordinator();
    for (let index = 0; index < 65; index += 1) {
      await lifecycle.logout({ account: claudeAccount, idempotencyKey: `bounded_${index}` });
    }
    const receipts = JSON.parse(await readFile(
      join(homePath, "system/ai-providers/lifecycle-receipts.json"),
      "utf8",
    ));
    expect(receipts.receipts).toHaveLength(64);
    expect(receipts.receipts[0].key).toBe("bounded_1");
  });
});
