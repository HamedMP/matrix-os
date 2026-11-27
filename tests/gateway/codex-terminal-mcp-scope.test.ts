import { desktopLinkWorkspaceId } from "@matrix-os/contracts/desktop-link";
import { herdrControlParts } from "./fixtures/herdr-chat-control-parts.js";
import { describe, it, expect } from "vitest";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import {
  createCodexMcpRunScope,
  nativeCodexMcpExecution,
  withOwnerHerdrAdmission,
} from "../../packages/gateway/src/chat/codex-mcp-run-scope.js";
import {
  codexTerminalMcpThreadConfig,
  codexTerminalMcpChildEnvironment,
} from "../../packages/gateway/src/coding-agents/codex-terminal-mcp.mjs";
import type { CanonicalProviderRunInput } from "../../packages/gateway/src/chat/provider-adapter.js";
const input = (signal: AbortSignal, runId = "run_one") =>
  ({
    owner: { type: "personal", ownerId: "owner" },
    chatId: "chat_one",
    runId,
    ownerSubmittedHerdrTurn: true as const,
    parts: herdrControlParts(),
    interactionMode: "default",
    permissionMode: "full_access",
    executionRoot: "/home/matrix/home/worktrees/wt_7777777777777777",
    worktreeId: "wt_7777777777777777",
    signal,
  }) as CanonicalProviderRunInput;
describe("native Codex Terminal MCP capability", () => {
  it.each(["default", "plan", "review"] as const)("discovers computers from a private %s Chat without a bound worktree", interactionMode => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "owner", herdrDiscoveryAvailable: true });
    const scopes = createCodexMcpRunScope({ issuer: registry, gatewayPort: 4000 });
    const base = input(new AbortController().signal);
    const opened = scopes.open({
      ...base, parts: [{ type: "text", text: "Which computers can I use?" }],
      ownerSubmittedHerdrTurn: undefined, ownerSubmittedHerdrDiscovery: true,
      worktreeId: undefined, executionRoot: undefined, interactionMode, permissionMode: "supervised",
    });
    expect(opened?.lease.discoveryOnly).toBe(true);
    expect(registry.resolveRunContext(opened!.lease.token, "POST", "/api/chat/herdr-terminal")?.herdr).toBeUndefined();
    opened?.close();
    registry.close();
  });
  it("binds the exact linked desktop and terminal chosen in the owner turn", () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "owner" });
    const scopes = createCodexMcpRunScope({ issuer: registry, gatewayPort: 4000 });
    const ref = { workspaceId: desktopLinkWorkspaceId("a".repeat(64)), tabId: `tt_${"7".repeat(32)}` };
    const base = input(new AbortController().signal);
    const parts = base.parts.map(part => part.type === "resource_reference" ? {
      ...part, resource: { ...part.resource, id: `${ref.workspaceId}:${ref.tabId}` },
    } : part);
    const opened = scopes.open({ ...base, parts });
    expect(opened).toBeDefined();
    const target = registry.resolveRunContext(opened!.lease.token, "POST", "/api/chat/herdr-terminal")?.herdr;
    expect(target?.ref).toEqual(ref);
    expect(target?.revision).toBe("a".repeat(64));
    opened?.close();
    registry.close();
  });
  it("derives the ephemeral control admission only from a committed owner message in the current first attempt", () => {
    const run = { chatId: "chat_test", turnId: "cturn_selected", attempt: 1, driverKind: "codex" } as Parameters<
      typeof withOwnerHerdrAdmission
    >[0];
    const message = {
      chatId: run.chatId,
      turnId: run.turnId,
      role: "user",
      state: "committed",
      actorId: "owner",
      purpose: "ai_request",
      parts: herdrControlParts(),
    } as Parameters<typeof withOwnerHerdrAdmission>[1];
    const owner = { type: "personal" as const, ownerId: "owner" };
    expect(withOwnerHerdrAdmission(run, message, owner, true).ownerSubmittedHerdrTurn).toBe(true);
    expect(withOwnerHerdrAdmission(run, message, owner)).toBe(run);
    for (const changed of [
      { role: "system" as const },
      { actorId: "other" },
      { purpose: "discussion" as const },
      { turnId: "cturn_other" },
      { chatId: "chat_other" },
    ]) {
      expect(withOwnerHerdrAdmission(run, { ...message, ...changed }, owner, true)).toBe(run);
    }
    expect(
      withOwnerHerdrAdmission({ ...run, attempt: 2 }, message, owner, true).ownerSubmittedHerdrTurn,
    ).toBeUndefined();
  });
  it("an asynchronously retained host context cannot dispatch after exact-run cancellation", async () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "owner" }),
      sources = createCodexMcpRunScope({ issuer: registry, gatewayPort: 4000 }),
      source = sources.open(input(new AbortController().signal))!;
    let release!: () => void;
    const waiting = new Promise<void>((done) => {
      release = done;
    });
    const lease = source.lease;
    const deferred = source.withContext(async () => {
      await waiting;
      return nativeCodexMcpExecution("owner");
    });
    sources.cancel({ ownerId: "foreign", chatId: "chat_one", runId: "run_one" });
    expect(registry.resolve(lease.token, "POST", "/api/chat/herdr-terminal")).toBe("owner");
    sources.cancel({ ownerId: "owner", chatId: "chat_one", runId: "run_one" });
    release();
    await expect(deferred).rejects.toThrow("Matrix MCP run unavailable");
    expect(registry.resolve(lease.token, "POST", "/api/chat/herdr-terminal")).toBeNull();
    registry.close();
  });
  it("carries only the actual private run through host scope and revokes on final/Stop", () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "owner" }),
      sources = createCodexMcpRunScope({ issuer: registry, gatewayPort: 4000 }),
      controller = new AbortController();
    const source = sources.open(input(controller.signal));
    const lease = source!.withContext(() => nativeCodexMcpExecution("owner"))!;
    expect(registry.resolve(lease.token, "POST", "/api/chat/herdr-terminal")).toBe("owner");
    expect(() => source!.withContext(() => nativeCodexMcpExecution("foreign"))).toThrow();
    controller.abort();
    expect(registry.resolve(lease.token, "POST", "/api/chat/herdr-terminal")).toBeNull();
    source?.close();
    registry.close();
  });
  it("fresh run gets a fresh token; waiting does not revoke it, close does", async () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "owner" }),
      sources = createCodexMcpRunScope({ issuer: registry, gatewayPort: 4000 }),
      c = new AbortController(),
      first = sources.open(input(c.signal))!;
    const one = first.withContext(() => nativeCodexMcpExecution("owner"))!;
    await Promise.resolve();
    expect(registry.resolve(one.token, "POST", "/api/chat/herdr-terminal")).toBe("owner");
    first.close();
    const next = sources.open(input(c.signal, "run_two"))!,
      two = next.withContext(() => nativeCodexMcpExecution("owner"))!;
    expect(two.token).not.toBe(one.token);
    expect(registry.resolve(one.token, "POST", "/api/chat/herdr-terminal")).toBeNull();
    expect(registry.resolveRunContext(two.token, "POST", "/api/chat/herdr-terminal")?.runId).toBe("run_two");
    next.close();
    registry.close();
  });
  it("no issuer, plan/review/shared/unbound sources cannot acquire executable Terminal tools", () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "owner" }),
      sources = createCodexMcpRunScope({ issuer: registry, gatewayPort: 4000 }),
      base = input(new AbortController().signal);
    expect(createCodexMcpRunScope(undefined).open(base)).toBeUndefined();
    for (const change of [
      { interactionMode: "plan" },
      { interactionMode: "review" },
      { sharedScopeId: "shared" },
      { worktreeId: undefined },
      { owner: { type: "organization", ownerId: "owner" } },
    ])
      expect(sources.open({ ...base, ...change } as CanonicalProviderRunInput)).toBeUndefined();
    registry.close();
  });
  it("keeps the Herdr credential out of thread config and preserves other Matrix tools", () => {
    const lease = {
      attemptId: "11111111-1111-4111-8111-111111111111",
      token: "a".repeat(64),
      gatewayPort: 4250,
      launcher: "/opt/matrix/bin/matrix-integrations-mcp" as const,
    } as const;
    const config = codexTerminalMcpThreadConfig(lease);
    expect(JSON.stringify(config)).not.toContain(lease.token);
    expect(config["mcp_servers.matrix-herdr"]).toMatchObject({ enabled: false });
    expect(config["mcp_servers.matrix-terminal"]).toMatchObject({
      args: ["--require-scoped-capability", "--tool-surface=chat-herdr", "--harness=codex"],
      enabled_tools: ["terminal_list", "terminal_read", "terminal_send", "terminal_interrupt"],
      env_vars: ["MATRIX_HERDR_RUN_TOKEN", "GATEWAY_URL"],
    });
    expect(config).not.toHaveProperty("mcp_servers.matrix-integrations");
    const env = { MATRIX_AGENT_INTEGRATIONS_TOKEN: "core", MATRIX_HERDR_RUN_TOKEN: "old" };
    expect(codexTerminalMcpChildEnvironment(env, undefined)).toEqual({ MATRIX_AGENT_INTEGRATIONS_TOKEN: "core" });
    expect(codexTerminalMcpChildEnvironment(env, lease)).toEqual({
      MATRIX_AGENT_INTEGRATIONS_TOKEN: "core",
      MATRIX_HERDR_RUN_TOKEN: lease.token,
      GATEWAY_URL: "http://127.0.0.1:4250",
    });
  });

  it("admits the new structured Terminal Control command and still accepts the stored legacy command", () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "owner" });
    const scope = createCodexMcpRunScope({ issuer: registry, gatewayPort: 4000 });
    const base = input(new AbortController().signal);
    try {
      const old = scope.open(base);
      expect(old).toBeDefined();
      old?.close();
      const parts = base.parts.map(part => part.type === "invocation_reference"
        ? { ...part, invocation: { ...part.invocation, descriptorId: "terminal-control", invocation: "/terminal-control" } }
        : part);
      const current = scope.open({ ...base, parts });
      expect(current).toBeDefined();
      current?.close();
      const mismatched = parts.map(part => part.type === "invocation_reference"
        ? { ...part, invocation: { ...part.invocation, invocation: "/herdr-terminal-control" } }
        : part);
      expect(scope.open({ ...base, parts: mismatched })).toBeUndefined();
    } finally {
      registry.close();
    }
  });

  it("a terminal reference or slash text alone cannot authorize a terminal, and recovery cannot inherit consent", () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "owner" });
    const scope = createCodexMcpRunScope({ issuer: registry, gatewayPort: 4000 });
    const base = input(new AbortController().signal);
    const [text, marker, terminal] = herdrControlParts();
    try {
      for (const change of [
        { parts: [text, terminal] },
        { parts: [text, marker] },
        { parts: [text, marker, terminal, terminal] },
        { parts: [text, marker, marker, terminal] },
        { parts: [{ type: "text", text: "/herdr-terminal-control" }, terminal] },
        { permissionMode: "supervised" },
        { continuationId: "continue" },
        { ownerSubmittedHerdrTurn: undefined },
        { nativeScheduled: { sourceRunId: "scheduled" } },
      ])
        expect(scope.open({ ...base, ...change } as CanonicalProviderRunInput)).toBeUndefined();
    } finally {
      registry.close();
    }
  });
});
