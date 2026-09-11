import { Hono } from "hono";
import { KyselyPGlite } from "kysely-pglite";
import { CanonicalProviderCatalogSchema, type CanonicalChatContentFrame } from "@matrix-os/contracts";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { hermesStartupInput, hermesStartupProcesses } from "./hermes-startup-process";
import { createHermesChatProviderAdapter } from "../../packages/gateway/src/chat/hermes-provider-adapter";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator";
import { ChatRepository } from "../../packages/gateway/src/chat/repository";
import { createCanonicalChatEventStream } from "../../packages/gateway/src/chat/event-stream";
import { registerCanonicalChatEventHttpRoute } from "../../packages/gateway/src/chat/event-http-route";
import { createCanonicalChatEventSource } from "../../packages/ui/src/canonical-chat-event-source";

export async function hermesStartupStreamHarness(options: Parameters<typeof hermesStartupProcesses>[0]) {
  const process = hermesStartupProcesses(options);
  const { owner, chatId, selection } = hermesStartupInput;
  const principal = { userId: owner.ownerId, source: "jwt" as const };
  const fixture = createCanonicalProviderCatalogFixture();
  const catalog = CanonicalProviderCatalogSchema.parse({ ...fixture,
    drivers: [{ ...fixture.drivers[0], kind: "hermes", displayName: "Hermes", capabilityClass: "system_agent" }],
    instances: [{ ...fixture.instances[0], id: selection.instanceId, driverKind: "hermes", displayName: "Hermes",
      models: [{ ...fixture.instances[0]!.models[0], id: selection.model, displayName: "Hermes model" }],
      defaultSelection: selection }],
  });
  const db = await KyselyPGlite.create();
  const repository = new ChatRepository(db.dialect);
  await repository.bootstrap();
  await repository.create(owner, { id: chatId, clientRequestId: "req_hermes_stream", title: "Hermes startup" });
  const adapter = createHermesChatProviderAdapter({ homePath: "/safe/home", spawnFn: process.spawnFn, readyTimeoutMs: 10 });
  const root = { ref: { kind: "project" as const, projectId: "project_startup" },
    fingerprint: "a".repeat(64), primaryWorkspaceRoot: "/safe/project", projectSlug: "startup" };
  const orchestrator = new CanonicalChatOrchestrator({ repository, shutdownDrainMs: 25,
    catalog: { getCatalog: async () => catalog }, adapters: new CanonicalChatProviderRegistry([adapter]),
    executionRoots: { resolve: async () => root, revalidate: async () => root },
  });
  const stream = createCanonicalChatEventStream({ repository });
  const app = new Hono();
  registerCanonicalChatEventHttpRoute({ app, stream, getPrincipal: () => principal });
  const source = createCanonicalChatEventSource({ openStream: async ({ signal, cursor }) => app.request(
    `/api/chats/events?messageVersion=2${cursor === undefined ? "" : `&cursor=${cursor}`}`,
    { signal, headers: { accept: "text/event-stream", "x-matrix-chat-protocol": "2" } },
  ) });
  const frames: CanonicalChatContentFrame[] = [];
  source.subscribe((event) => {
    if (event.type === "chat.changed" && event.content) {
      if (frames.length >= 256) throw new Error("Startup fixture exceeded frame limit");
      frames.push(event.content);
    }
  });
  let admittedWork = Promise.resolve();
  return { owner, chatId, catalog, repository, source, frames, process, orchestrator,
    getDetail: async () => (await repository.getDetailPage(owner, chatId, { limit: 200 }))!,
    async admit(clientRequestId = "req_hermes_start_turn", baseRevision = 0) {
      const admitted = await orchestrator.admitTurn(principal, owner, chatId, { clientRequestId, baseRevision,
        parts: hermesStartupInput.parts, selection, permissionMode: "full_access", interactionMode: "default", executionRoot: root.ref });
      admittedWork = orchestrator.drain();
      return admitted;
    },
    async close() {
      // Even a failed assertion releases the test-owned fake child before DB disposal.
      process.children.forEach((child) => child.exit());
      await orchestrator.close();
      await admittedWork;
      source.dispose(); stream.shutdown(); await repository.kysely.destroy();
    },
  };
}
