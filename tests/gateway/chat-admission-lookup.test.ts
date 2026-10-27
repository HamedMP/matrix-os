import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CanonicalChatTurnAdmissionResponseSchema } from "@matrix-os/contracts";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatRoutes, type CanonicalChatRouteService } from "../../packages/gateway/src/chat/routes.js";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service.js";
import { MissingRequestPrincipalError } from "../../packages/gateway/src/request-principal.js";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";

const owner = { type: "personal" as const, ownerId: "owner_admission_lookup" };
const { snapshot } = createCanonicalChatFixture("accepted");
const chatId = snapshot.chat.id;
const turn = snapshot.turns[0]!;
const requestHash = createHash("sha256").update(JSON.stringify({
  parts: snapshot.messages[0]!.parts,
  selection: { instanceId: "codex_fixture", model: "original-model" },
  interactionMode: "plan", permissionMode: "full_access", executionRoot: null,
})).digest("hex");

describe("canonical Chat admission lookup", () => {
  let repository: ChatRepository;
  let service: CanonicalChatRouteService;

  beforeAll(async () => {
    const database = await createTestPGlite();
    repository = new ChatRepository(database.dialect);
    await repository.bootstrap();
    await repository.create(owner, { id: chatId, clientRequestId: "req_lookup_create", title: "Lookup" });
    await repository.admitTurn(owner, {
      chatId, baseRevision: 0, requestHash,
      message: snapshot.messages[0]!, turn, run: snapshot.runs[0]!,
    });
    service = createCanonicalChatService(repository);
  });

  afterAll(async () => { await repository?.kysely.destroy(); });

  function routes(options: { userId?: string; service?: CanonicalChatRouteService; unauthenticated?: boolean } = {}) {
    return createCanonicalChatRoutes({
      service: options.service ?? service,
      getPrincipal: () => {
        if (options.unauthenticated) throw new MissingRequestPrincipalError();
        return { userId: options.userId ?? owner.ownerId, source: "jwt" };
      },
    });
  }

  function url(hash = requestHash, requestId = turn.clientRequestId, targetChatId = chatId) {
    return `/api/chats/${targetChatId}/turn-admissions/${requestId}?requestHash=${hash}&messageVersion=2`;
  }

  it("recovers original request identity despite effective model and mode overrides without admitting work", async () => {
    const before = await repository.get(owner, chatId);
    const app = routes();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.request(url());
      expect(response.status).toBe(200);
      const admitted = CanonicalChatTurnAdmissionResponseSchema.parse(await response.json());
      expect(admitted.admission).toBe("already_accepted");
      expect(admitted.turn.id).toBe(turn.id);
      expect(admitted.run.selection.model).toBe("gpt-5.6-sol");
      expect(admitted.run.interactionMode).toBe("default");
      expect(admitted.run.permissionMode).toBe("supervised");
    }
    expect(await repository.get(owner, chatId)).toEqual(before);
    const detail = await repository.getDetailPage(owner, chatId, { limit: 200 });
    expect(detail?.turns).toHaveLength(1);
    expect(detail?.runs).toHaveLength(1);
    expect(detail?.messages).toHaveLength(1);
  });

  it("rejects a reused request key with a different original payload hash", async () => {
    const response = await routes().request(url("f".repeat(64)));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "chat_conflict" } });
  });

  it.each([
    { name: "unknown request", path: url(requestHash, "req_unknown") },
    { name: "unknown Chat", path: url(requestHash, turn.clientRequestId, "chat_unknown") },
  ])("returns 404 for $name", async ({ path }) => {
    expect((await routes().request(path)).status).toBe(404);
  });

  it("uses the authenticated owner rather than caller supplied ownership", async () => {
    const response = await routes({ userId: "another_owner" }).request(`${url()}&ownerId=${owner.ownerId}`);
    expect(response.status).toBe(404);
  });

  it("requires an authenticated principal", async () => {
    expect((await routes({ unauthenticated: true }).request(url())).status).toBe(401);
  });

  it.each([
    url("invalid"), url("A".repeat(64)), url(requestHash, "wrong_request_id"),
    url(requestHash, turn.clientRequestId, "wrong_chat_id"),
    `${url()}&requestHash=${requestHash}`, url().replace(`requestHash=${requestHash}&`, ""),
  ])("rejects invalid identity before lookup: %s", async (path) => {
    expect((await routes().request(path)).status).toBe(400);
  });

  it("returns a generic 503 when the lookup service is unavailable", async () => {
    const unavailable = { ...service, getTurnAdmission: undefined };
    const response = await routes({ service: unavailable }).request(url());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/TypeError|findTurnAdmission|undefined/);
  });

  it("returns a generic 503 when a legacy repository lacks lookup support", async () => {
    const legacyRepository = Object.create(repository) as ChatRepository;
    Object.defineProperty(legacyRepository, "findTurnAdmission", { value: undefined });
    const response = await routes({ service: createCanonicalChatService(legacyRepository) }).request(url());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/TypeError|findTurnAdmission|undefined/);
  });

  it("returns a generic 503 for repository failures", async () => {
    const failedRepository = Object.create(repository) as ChatRepository;
    Object.defineProperty(failedRepository, "findTurnAdmission", {
      value: async () => { throw new Error("postgres host secret.internal:5432 unavailable"); },
    });
    const response = await routes({ service: createCanonicalChatService(failedRepository) }).request(url());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/postgres|secret\.internal|5432/);
  });
});
