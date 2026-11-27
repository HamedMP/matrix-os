import { createHmac } from "node:crypto";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { Hono } from "hono";
import { adapter as recordingAdapter, catalog, owner, principal } from "./chat-orchestrator-test-support.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { createCanonicalChatRoutes, type CanonicalChatRouteService } from "../../packages/gateway/src/chat/routes.js";
import { createCodexMcpRunScope } from "../../packages/gateway/src/chat/codex-mcp-run-scope.js";
import { herdrControlParts } from "./fixtures/herdr-chat-control-parts.js";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import { nativeCodexMcpExecution } from "../../packages/gateway/src/chat/codex-mcp-run-scope.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { MANAGED_TERMINAL_OWNER_GRANT_HEADER } from "@matrix-os/contracts/managed-terminal-control";
afterEach(() => vi.unstubAllEnvs());

it("exposes the actual canonical Codex run to delayed native startup and rotates/revokes on successor", async () => {
  const home = await mkdtemp("/tmp/mx-mcp-chat-"),
    registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "owner_terminal" });
  const seen: string[] = [];
  const finish = async ({ principal, thread, now, nextEventId }) => {
    await Promise.resolve();
    const lease = nativeCodexMcpExecution(principal.userId)!;
    seen.push(lease.token);
    expect(registry.resolveRunContext(lease.token, "POST", "/api/chat/herdr-terminal")?.runId).toBe(
      seen.length === 1 ? "run_first" : "run_second",
    );
    return {
      outcome: "completed",
      events: [
        {
          type: "thread.completed",
          eventId: nextEventId(),
          threadId: thread.id,
          occurredAt: now().toISOString(),
          outcome: "completed",
        },
      ],
      resumeState: { conversationId: "native_terminal_thread" },
    };
  };
  const threads = createCodingAgentThreadStore({
    homePath: home,
    providers: [{ providerId: "codex", initialRunExecution: "background", startThread: finish, resumeTurn: finish }],
    relationValidator: { validateCreate: async () => {}, validateThread: async () => {} },
  });
  const adapter = createCanonicalCodingChatProviderAdapter({
    providerId: "codex",
    threads,
    matrixMcpCapabilityIssuer: registry,
    gatewayPort: 4000,
  });
  const base = {
    owner: { type: "personal" as const, ownerId: "owner_terminal" },
    chatId: "chat_terminal",
    turnId: "cturn_terminal",
    runId: "run_first",
    prompt: "Synthetic",
    ownerSubmittedHerdrTurn: true as const,
    parts: herdrControlParts(),
    selection: { instanceId: "codex_personal_secondary", model: "gpt-5.6-sol" },
    interactionMode: "default",
    permissionMode: "full_access",
    executionRoot: "/home/matrix/home/worktrees/wt_7777777777777777",
    worktreeId: "wt_7777777777777777",
    signal: new AbortController().signal,
  };
  try {
    let state;
    for await (const event of adapter.start!(base)) {
      if (event.type === "state.updated") state = event.state;
    }
    expect(seen).toHaveLength(1);
    expect(registry.resolve(seen[0], "POST", "/api/chat/herdr-terminal")).toBeNull();
    for await (const event of adapter.resume!({
      ...base,
      runId: "run_second",
      permissionMode: "full_access",
      resumeState: state,
    })) {
      expect(event.type).toBeTruthy();
    }
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(registry.resolve(seen[1], "POST", "/api/chat/herdr-terminal")).toBeNull();
  } finally {
    registry.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("grants the selected terminal through canonical HTTP admission; a later internal submission cannot reuse it", async () => {
  const repository = new ChatRepository((await createTestPGlite()).dialect);
  await repository.bootstrap();
  const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId });
  const scope = createCodexMcpRunScope({ issuer: registry, gatewayPort: 4000 });
  const runTokens: Array<string | null> = [];
  const authorities: unknown[] = [];
  const provider = recordingAdapter(async function* (input) {
    const opened = scope.open(input);
    try {
      runTokens.push(opened?.lease.token ?? null);
      if (opened) authorities.push(registry.resolveRunContext(opened.lease.token, "POST", "/api/chat/herdr-terminal")?.herdr?.authority);
      if (runTokens.length === 3) {
        expect(registry.resolveRunContext(opened!.lease.token, "POST", "/api/chat/herdr-terminal")?.scope)
          .toBe("chat_herdr_discovery");
        expect(opened!.lease.discoveryOnly).toBe(true);
      }
      yield { type: "run.completed", outcome: "completed" };
    } finally {
      opened?.close();
    }
  });
  const options = catalog();
  options.instances[0]!.supports.permissionModes.push("full_access");
  const ref = { kind: "worktree" as const, projectId: "project_matrix", worktreeId: "wt_7777777777777777" };
  const resolved = {
    ref,
    fingerprint: "b".repeat(64),
    primaryWorkspaceRoot: "/isolated/herdr",
    projectSlug: "matrix-os",
  };
  const orchestrator = new CanonicalChatOrchestrator({
    repository,
    catalog: { getCatalog: async () => options },
    adapters: new CanonicalChatProviderRegistry([provider]),
    executionRoots: { resolve: async () => resolved, revalidate: async () => resolved },
  });
  const gatewayToken = "owner-gateway-test-token";
  vi.stubEnv("MATRIX_USER_ID", owner.ownerId);
  vi.stubEnv("MATRIX_CLERK_USER_ID", owner.ownerId);
  const ownerHeaders = (actorId: string) => ({
    authorization: `Bearer ${gatewayToken}`, "content-type": "application/json",
    "x-platform-user-id": actorId,
    "x-platform-verified": createHmac("sha256", gatewayToken).update(actorId).digest("hex"),
  });
  const app = new Hono().use("*", authMiddleware(gatewayToken)).route(
    "/",
    createCanonicalChatRoutes({
      service: { admitTurn: orchestrator.admitTurn.bind(orchestrator) } as CanonicalChatRouteService,
      getPrincipal: requireRequestPrincipal,
    }),
  );
  const chatId = "chat_herdr_owner";
  const body = {
    clientRequestId: "req_herdr_action",
    baseRevision: 0,
    parts: herdrControlParts(),
    selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
    permissionMode: "full_access",
    interactionMode: "default",
    executionRoot: ref,
  };
  try {
    await repository.create(owner, {
      id: chatId,
      clientRequestId: "req_create_herdr_owner",
      title: "Synthetic",
      projectId: ref.projectId,
    });
    const response = await app.request(`/api/chats/${chatId}/turns`, {
      method: "POST",
      headers: ownerHeaders(owner.ownerId),
      body: JSON.stringify(body),
    });
    expect(response.status, await response.text()).toBe(202);
    await orchestrator.drain();
    expect(runTokens).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
    const record = await repository.get(owner, chatId);
    await orchestrator.admitTurn(principal, owner, chatId, {
      ...body,
      baseRevision: record!.chat.revision,
      clientRequestId: "req_internal_copy",
    });
    await orchestrator.drain();
    expect(runTokens).toEqual([expect.any(String), null]);
    const afterInternal = await repository.get(owner, chatId);
    const question = await app.request(`/api/chats/${chatId}/turns`, {
      method: "POST", headers: ownerHeaders(owner.ownerId),
      body: JSON.stringify({ ...body, clientRequestId: "req_owner_discovery", baseRevision: afterInternal!.chat.revision,
        parts: [{ type: "text", text: "What terminals are available?" }] }),
    });
    expect(question.status, await question.text()).toBe(202);
    await orchestrator.drain();
    expect(runTokens).toEqual([expect.any(String), null, expect.any(String)]);

    const otherId = "user_foreign";
    const otherChat = "chat_herdr_other";
    await repository.create({ type: "personal", ownerId: otherId }, {
      id: otherChat, clientRequestId: "req_create_foreign_chat", title: "Foreign private Chat",
    });
    const foreignRequest = (parts: typeof body.parts, clientRequestId: string) =>
      app.request(`/api/chats/${otherChat}/turns`, {
        method: "POST",
        headers: { ...ownerHeaders(otherId), "x-matrix-owner-id": owner.ownerId },
        body: JSON.stringify({ ...body, executionRoot: undefined, permissionMode: "supervised",
          baseRevision: 0, parts, clientRequestId }),
      });
    const foreignSelect = await foreignRequest(herdrControlParts(), "req_foreign_select");
    expect(foreignSelect.status, await foreignSelect.text()).toBe(403);
    const foreignAsk = await foreignRequest([{ type: "text", text: "Which computers?" }], "req_foreign_ask");
    expect(foreignAsk.status, await foreignAsk.text()).toBe(202);
    await orchestrator.drain();
    expect(runTokens.at(-1)).toBeNull();

    const latest = await repository.get(owner, chatId);
    const clientRequestId = "req_managed_terminal";
    const managedParts = herdrControlParts().map(part => part.type === "resource_reference"
      ? { ...part, resource: { ...part.resource, id: "tws_6d6774" + "1".repeat(26) + ":tt_" + "7".repeat(32) } }
      : part);
    const requestManaged = (proof?: string) => app.request(`/api/chats/${chatId}/turns`, {
      method: "POST", headers: { ...ownerHeaders(owner.ownerId), ...(proof ? { [MANAGED_TERMINAL_OWNER_GRANT_HEADER]: proof } : {}) },
      body: JSON.stringify({ ...body, parts: managedParts, clientRequestId, baseRevision: latest!.chat.revision }),
    });
    expect((await requestManaged()).status).toBe(403);
    const proof = "fixture." + "d".repeat(64);
    const responseWithProof = await requestManaged(proof);
    expect(responseWithProof.status, await responseWithProof.text()).toBe(202);
    await orchestrator.drain();
    expect(authorities.at(-1)).toEqual({ proof, clientRequestId, bodyDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(await repository.get(owner, chatId))).not.toContain(proof);

  } finally {
    await orchestrator.close();
    registry.close();
    await repository.kysely.destroy();
  }
});
