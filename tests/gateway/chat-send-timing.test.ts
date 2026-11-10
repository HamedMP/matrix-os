import { adapter, catalog, owner, principal } from "./chat-orchestrator-test-support.js";
import type { KyselyPGlite } from "kysely-pglite";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createChatSendTimer, recordCodexCatalogTiming } from "../../packages/gateway/src/chat/send-timing.js";
import { codexCatalogFixture, codexProvider } from "../helpers/codex-model-catalog-fixture.js";

type TimingEvent = { traceId?: string; runId?: string; stage: string; durationMs?: number; result?: string; driver?: string };

function captureTimings() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    if (args[0] === "[chat-send-timing]") lines.push(String(args[1]));
  });
  return { lines, events: () => lines.map((line) => JSON.parse(line) as TimingEvent), restore: () => spy.mockRestore() };
}

describe("Chat send timings", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let repository: ChatRepository;

  beforeEach(async () => {
    pglite = await createTestPGlite();
    repository = new ChatRepository(pglite.dialect);
    await repository.bootstrap();
    await repository.create(owner, { id: "chat_timed", clientRequestId: "req_create_timed", title: "Timed" });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await repository.kysely.destroy();
  });

  async function send(clientRequestId: string) {
    const provider = adapter(async function* () {
      yield { type: "assistant.delta", delta: "private assistant reply" };
      yield { type: "run.completed", outcome: "completed" };
    });
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => { recordCodexCatalogTiming("cache_hit", 1); return catalog(); } },
      adapters: new CanonicalChatProviderRegistry([provider]),
    });
    const admitted = await orchestrator.admitTurn(principal, owner, "chat_timed", {
      clientRequestId,
      baseRevision: 0,
      parts: [{ type: "text", text: "private prompt text" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
    });
    await orchestrator.drain();
    return admitted;
  }

  it("emits nothing when the flag is off", async () => {
    const capture = captureTimings();
    try {
      await send("req_untimed_turn");
      expect(capture.lines).toEqual([]);
    } finally { capture.restore(); }
  });

  it("attributes admission and dispatch stages without prompts, replies, or request IDs", async () => {
    vi.stubEnv("MATRIX_CODEX_SEND_TIMINGS", "1");
    const capture = captureTimings();
    try {
      const admitted = await send("req_private_timed_turn");
      const events = capture.events();
      const admissionStages = events.filter((event) => event.traceId).map((event) => event.stage);
      expect(admissionStages).toEqual([
        "admission_pre_catalog", "codex_catalog", "catalog_admission", "admission_post_catalog",
        "repository_admission", "run_link", "admission_total",
      ]);
      expect(events.find((event) => event.stage === "codex_catalog")?.result).toBe("cache_hit");
      expect(events.find((event) => event.stage === "run_link")).toMatchObject({ runId: admitted.run.id, driver: "codex" });
      const dispatch = events.filter((event) => !event.traceId).map((event) => [event.runId, event.stage]);
      expect(dispatch).toEqual([
        [admitted.run.id, "dispatch_prepare"],
        [admitted.run.id, "first_provider_event"],
        [admitted.run.id, "first_displayable_text"],
      ]);
      expect(new Set(events.filter((event) => event.traceId).map((event) => event.traceId)).size).toBe(1);
      expect(events.every((event) => event.durationMs === undefined || event.durationMs >= 0)).toBe(true);
      expect(capture.lines.join(" ")).not.toMatch(/private|req_private_timed_turn|chat_timed|owner_orchestrator/);
    } finally { capture.restore(); }
  });

  it("keeps concurrent catalog reads attributed to their own send", async () => {
    const capture = captureTimings();
    try {
      const first = createChatSendTimer("private-first-request");
      const second = createChatSendTimer("private-second-request");
      await Promise.all([
        first.run(async () => { await Promise.resolve(); recordCodexCatalogTiming("lookup_shared", 2); }),
        second.run(async () => { await Promise.resolve(); recordCodexCatalogTiming("lookup", 9); }),
      ]);
      const events = capture.events();
      expect(events.map((event) => event.result).sort()).toEqual(["lookup", "lookup_shared"]);
      expect(events[0]?.traceId).not.toBe(events[1]?.traceId);
      expect(capture.lines.join(" ")).not.toMatch(/private-(first|second)-request/);
    } finally { capture.restore(); }
  });

  it("labels blocking Codex catalog lookups, shared lookups, and cache hits", async () => {
    const f = codexCatalogFixture();
    const capture = captureTimings();
    try {
      const timer = createChatSendTimer("req_catalog_timing");
      await timer.run(async () => {
        await Promise.all([f.source(codexProvider, principal), f.source(codexProvider, principal)]);
        await f.source(codexProvider, principal);
      });
      expect(capture.events().map((event) => [event.stage, event.result])).toEqual([
        ["codex_catalog", "lookup"], ["codex_catalog", "lookup_shared"], ["codex_catalog", "cache_hit"],
      ]);
      expect(f.attempts).toHaveLength(1);
    } finally { capture.restore(); }
  });

  it("records catalog timing only inside a timed send", () => {
    const capture = captureTimings();
    try {
      recordCodexCatalogTiming("lookup", 5);
      expect(capture.lines).toEqual([]);
    } finally { capture.restore(); }
  });
});
