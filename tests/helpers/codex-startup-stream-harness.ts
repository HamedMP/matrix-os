import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { KyselyPGlite } from "kysely-pglite";
import { vi } from "vitest";
import { CanonicalChatTransportFrameSchema, CanonicalProviderCatalogSchema,
  type CanonicalChatTransportFrame } from "@matrix-os/contracts";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store";
import { createWorkspaceCodingAgentProvider } from "../../packages/gateway/src/coding-agents/workspace-provider";
import { createCodexEventBridge, codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter";
import { ChatRepository } from "../../packages/gateway/src/chat/repository";
import { createCanonicalChatEventStream } from "../../packages/gateway/src/chat/event-stream";
import { registerCanonicalChatEventHttpRoute } from "../../packages/gateway/src/chat/event-http-route";
import { startCodexStartupRunner } from "./codex-startup-runner";

export async function createCodexStartupStreamHarness() {
  // Darwin Unix sockets have a short path ceiling; keep the native control path valid.
  const homePath = await mkdtemp("/tmp/ms-");
  const gatePath = join(homePath, "ready");
  const owner = { type: "personal" as const, ownerId: "owner_startup" };
  const principal = { userId: owner.ownerId, source: "jwt" as const };
  const chatId = "chat_startup";
  const selection = { instanceId: "codex_startup", model: "default", options: [] };
  const terminalRef = {
    workspaceId: "tws_00000000000000000000000000000001",
    tabId: "tt_00000000000000000000000000000001",
  } as const;
  const terminalSessionId = `${terminalRef.workspaceId}:${terminalRef.tabId}`;
  const fixture = createCanonicalProviderCatalogFixture();
  const catalog = CanonicalProviderCatalogSchema.parse({ ...fixture,
    drivers: [{ ...fixture.drivers[0], kind: "codex", displayName: "Codex" }],
    instances: [{ ...fixture.instances[0], id: selection.instanceId, driverKind: "codex",
      displayName: "Codex", models: [{ ...fixture.instances[0]!.models[0], id: "default", displayName: "Default" }],
      defaultSelection: selection }],
  });
  let runner: Awaited<ReturnType<typeof startCodexStartupRunner>> | undefined;
  const bridge = createCodexEventBridge({ homePath, pollIntervalMs: 50,
    runVersionCommand: async () => ({ stdout: "codex-cli 0.153.4", stderr: "" }),
    isRuntimeAlive: async () => !runner || (runner.child.exitCode === null && runner.child.signalCode === null),
  });
  const session = (id: string) => ({
    id, kind: "agent" as const, agent: "codex" as const, ownerId: owner.ownerId,
    runtime: { type: "zellij" as const, status: "running" as const, zellijSession: id,
      createdAt: new Date().toISOString() },
    terminalRef,
    terminalSessionId, transcriptPath: codexProviderEventPath(homePath, id),
    attachedClients: 0, writeMode: "owner" as const,
    startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
  });
  // External terminal creation is controlled; its launched runner, event bridge,
  // legacy thread store and canonical adapter are all real production code.
  const provider = createWorkspaceCodingAgentProvider({ providerId: "codex", agent: "codex", codexEvents: bridge,
    runtime: {
      async startSession({ request }) {
        const id = request.sessionId!;
        runner = await startCodexStartupRunner({ homePath, eventPath: codexProviderEventPath(homePath, id),
          timeoutMs: 1_000, readyGate: gatePath });
        return { ok: true as const, status: 201, session: session(id) };
      },
      async stopSession(id) { await runner?.close(); return { ok: true as const, session: session(id) }; },
    },
  });
  const threads = createCodingAgentThreadStore({ homePath, providers: [provider],
    relationValidator: { validateCreate: async () => undefined, validateThread: async () => undefined } });
  bridge.attachThreadStore(threads);
  const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads });
  const db = await KyselyPGlite.create();
  const repository = new ChatRepository(db.dialect);
  await repository.bootstrap();
  await repository.create(owner, { id: chatId, clientRequestId: "req_startup_create", title: "Startup recovery" });
  const root = { ref: { kind: "project" as const, projectId: "project_startup" },
    fingerprint: "a".repeat(64), primaryWorkspaceRoot: homePath, projectSlug: "startup" };
  const orchestrator = new CanonicalChatOrchestrator({ repository,
    catalog: { getCatalog: async () => catalog }, adapters: new CanonicalChatProviderRegistry([adapter]),
    executionRoots: { resolve: async () => root, revalidate: async () => root } });
  const stream = createCanonicalChatEventStream({ repository });
  const app = new Hono();
  registerCanonicalChatEventHttpRoute({ app, stream, getPrincipal: () => principal });
  const frames: CanonicalChatTransportFrame[] = [];
  const openStream = vi.fn(async ({ signal, cursor }: { signal: AbortSignal; cursor?: number }) => {
    const response = await app.request(`/api/chats/events?messageVersion=2${cursor === undefined ? "" : `&cursor=${cursor}`}`, {
      signal, headers: { accept: "text/event-stream", "x-matrix-chat-protocol": "2" },
    });
    const decoder = new TextDecoder();
    let buffered = "";
    return new Response(response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffered += decoder.decode(chunk, { stream: true });
        if (buffered.length > 512_000) throw new Error("Fixture SSE buffer limit exceeded");
        let end: number;
        while ((end = buffered.indexOf("\n\n")) >= 0) {
          const block = buffered.slice(0, end); buffered = buffered.slice(end + 2);
          const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
          if (data) {
            if (frames.length >= 256) throw new Error("Fixture SSE frame limit exceeded");
            frames.push(CanonicalChatTransportFrameSchema.parse(JSON.parse(data)));
          }
        }
        controller.enqueue(chunk);
      },
    })), { status: response.status, headers: response.headers });
  });
  return { homePath, owner, chatId, catalog, repository, orchestrator, frames, openStream,
    getRunner: () => runner,
    getDetail: async () => (await repository.getDetailPage(owner, chatId, { limit: 200 }))!,
    admit: () => orchestrator.admitTurn(principal, owner, chatId, { clientRequestId: "req_startup_turn", baseRevision: 0,
      parts: [{ type: "text", text: "Reply once" }], selection,
      interactionMode: "default", permissionMode: "supervised", executionRoot: root.ref }),
    release: () => writeFile(gatePath, "ready", { flag: "wx" }),
    async close() {
      await runner?.close();
      await bridge.drain(); await bridge.shutdown();
      await orchestrator.close(); await threads.shutdownTurns();
      stream.shutdown(); await repository.kysely.destroy();
      await rm(homePath, { recursive: true, force: true });
    },
  };
}
