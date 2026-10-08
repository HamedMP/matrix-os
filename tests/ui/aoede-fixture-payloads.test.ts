/**
 * Contract validation for the standalone Aoede fixture payloads.
 *
 * Every canned payload the fixture serves — bootstrap, canonical detail
 * (operations included), provider catalog, mutation responses and the played
 * voice server frames — must parse the authoritative Zod schemas. This keeps
 * the UI evidence honest: a scenario that drifts from the contract fails here
 * before anyone screenshots it.
 */
import { describe, expect, it } from "vitest";
import {
  AoedeBootstrapRequestSchema,
  AoedeBootstrapResponseSchema,
  CanonicalChatActionCancellationResponseSchema,
  CanonicalChatApprovalSubmissionResponseSchema,
  CanonicalChatDetailResponseSchema,
  CanonicalChatInputSubmissionResponseSchema,
  CanonicalChatRecordSchema,
  CanonicalChatRunCancellationResponseSchema,
  CanonicalProviderCatalogSchema,
} from "@matrix-os/contracts";
import { VoiceServerFrameSchema } from "@matrix-os/contracts/voice-session";
import { AOEDE_SCENARIOS, AOEDE_SCENARIO_IDS, scenarioById } from "../fixtures/aoede/ui-fixture/src/scenarios";
import { createFixtureBackend, createFixtureEvidence } from "../fixtures/aoede/ui-fixture/src/fixture-backend";
import { FIXTURE_CHAT_ID, FIXTURE_SESSION_ID, fixtureBootstrap, fixtureProviderCatalog } from "../fixtures/aoede/ui-fixture/src/payloads";
import { createCanonicalActionTools } from "../../packages/gateway/src/chat/action-tools";
import { CANONICAL_CODEX_POLICY_REVISION } from "../../packages/gateway/src/chat/coding-provider-adapter";

const REQUIRED_IDS = [
  "idle",
  "permission",
  "listening",
  "captions",
  "thinking",
  "tool-activity",
  "speaking",
  "approval",
  "clarification",
  "navigation-artifact",
  "reconnect",
  "failed",
  "ptt",
];

describe("aoede fixture scenario registry", () => {
  it("covers every required stable scenario id", () => {
    for (const id of REQUIRED_IDS) expect(AOEDE_SCENARIO_IDS).toContain(id);
  });
});

describe("aoede fixture payloads", () => {
  it("names only real canonical app tools and revisions — never invented ids", () => {
    const canonical = createCanonicalActionTools({ homeForOwner: async () => "/tmp/unused" });
    const realToolIds = new Set(canonical.map(tool => tool.toolId));
    const realSchemaRevisions = new Set(canonical.map(tool => tool.schemaRevision));
    expect([...realToolIds].sort()).toEqual([
      "matrix_apply_app_files", "matrix_close_app", "matrix_inspect_app",
      "matrix_list_apps", "matrix_open_app", "matrix_search_workspace",
    ]);

    // Capability/catalog tool advertisements must be a subset of the real inventory.
    for (const tools of [
      fixtureProviderCatalog().instances.flatMap(instance => instance.supports.tools),
      ...AOEDE_SCENARIOS.map(s => s.detail().runs?.flatMap(run => run.capabilitySnapshot.tools) ?? []),
    ]) {
      for (const toolId of tools) expect(realToolIds.has(toolId)).toBe(true);
    }

    // Every operation in every scenario must use a real toolId and the real revisions,
    // or toOperationView would never project its result detail in production.
    const operationSources = [
      ...AOEDE_SCENARIOS.flatMap(s => s.detail().operations ?? []),
    ];
    expect(operationSources.length).toBeGreaterThan(0);
    for (const op of operationSources) {
      expect(realToolIds.has(op.toolId), `op ${op.id} toolId ${op.toolId}`).toBe(true);
      expect(realSchemaRevisions.has(op.schemaRevision), `op ${op.id} schemaRevision`).toBe(true);
      expect(op.policyRevision, `op ${op.id} policyRevision`).toBe(CANONICAL_CODEX_POLICY_REVISION);
    }
  });

  for (const scenario of AOEDE_SCENARIOS) {
    it(`scenario "${scenario.id}" serves a contract-valid detail payload`, () => {
      const detail = scenario.detail();
      const parsed = CanonicalChatDetailResponseSchema.safeParse(detail);
      if (!parsed.success) {
        expect.fail(`detail for "${scenario.id}": ${parsed.error.issues.map(i => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      }
      expect(parsed.data.record.chat.id).toBe(FIXTURE_CHAT_ID);
    });

    it(`scenario "${scenario.id}" plays only contract-valid voice frames`, () => {
      scenario.media?.frames.forEach((frame, index) => {
        const parsed = VoiceServerFrameSchema.safeParse({
          contractVersion: 1,
          sessionId: FIXTURE_SESSION_ID,
          epoch: 1,
          sequence: index + 1,
          ...frame,
        });
        if (!parsed.success) {
          expect.fail(`frame ${index} (${frame.type}) for "${scenario.id}": ${parsed.error.issues.map(i => `${i.path.join(".")} ${i.message}`).join("; ")}`);
        }
      });
    });
  }

  it("serves a contract-valid bootstrap response", () => {
    expect(AoedeBootstrapResponseSchema.safeParse(fixtureBootstrap()).success).toBe(true);
    expect(AoedeBootstrapResponseSchema.safeParse(
      fixtureBootstrap({ capability: { ...fixtureBootstrap().capability, surface: "web_desktop" } }),
    ).success).toBe(true);
  });

  it("serves a contract-valid provider catalog with a qualified Codex instance", () => {
    const catalog = fixtureProviderCatalog();
    const parsed = CanonicalProviderCatalogSchema.safeParse(catalog);
    if (!parsed.success) expect.fail(parsed.error.issues.map(i => `${i.path.join(".")} ${i.message}`).join("; "));
    expect(parsed.data.instances.some(instance => instance.driverKind === "codex" && instance.supports.approvals)).toBe(true);
  });
});

describe("aoede fixture backend", () => {
  const backendFor = (id: string) => {
    const evidence = createFixtureEvidence();
    const scenario = scenarioById(id);
    const backend = createFixtureBackend({ detail: scenario.detail(), bootstrap: scenario.bootstrap, evidence });
    return { evidence, backend };
  };
  const post = (fetcher: typeof fetch, path: string, body: unknown) =>
    fetcher(`https://fixture.test${path}`, { method: "POST", body: JSON.stringify(body) });

  it("answers bootstrap with a contract-valid response and echoes the surface", async () => {
    const { backend, evidence } = backendFor("listening");
    const request = { clientRequestId: "req_fixture_boot", intent: "continue", surface: "web_desktop" };
    expect(AoedeBootstrapRequestSchema.safeParse(request).success).toBe(true);
    const response = await post(backend.fetcher, "/api/aoede/bootstrap", request);
    expect(response.status).toBe(200);
    const parsed = AoedeBootstrapResponseSchema.safeParse(await response.json());
    if (!parsed.success) expect.fail(parsed.error.issues.map(i => i.message).join("; "));
    expect(parsed.data.capability.surface).toBe("web_desktop");
    expect(evidence.snapshot().calls[0]?.path).toBe("/api/aoede/bootstrap");
    expect(evidence.snapshot().schemaIssues).toEqual([]);
  });

  it("streams a contract-valid attached frame on the canonical event stream", async () => {
    const { backend } = backendFor("idle");
    const response = await backend.fetcher("https://fixture.test/api/chats/events", { headers: { Accept: "text/event-stream" } });
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("\"type\":\"chat.stream.attached\"");
    await reader.cancel();
  });

  it("serves the scenario detail and providers catalog over the fetcher", async () => {
    const { backend } = backendFor("navigation-artifact");
    const detail = await backend.fetcher(`https://fixture.test/api/chats/${FIXTURE_CHAT_ID}?limit=200`, {});
    expect(CanonicalChatDetailResponseSchema.safeParse(await detail.json()).success).toBe(true);
    const catalog = await backend.fetcher("https://fixture.test/api/chat-providers", {});
    expect(CanonicalProviderCatalogSchema.safeParse(await catalog.json()).success).toBe(true);
  });

  it("resolves pending approvals through the canonical mutation contract", async () => {
    const { backend } = backendFor("approval");
    const response = await post(
      backend.fetcher,
      `/api/chats/${FIXTURE_CHAT_ID}/runs/run_aoede_1/approvals/approval_apply_timer`,
      { clientRequestId: "req_fixture_approve", decision: "approve", argumentDigest: "ab".repeat(32) },
    );
    expect(response.status).toBe(200);
    const parsed = CanonicalChatApprovalSubmissionResponseSchema.safeParse(await response.json());
    if (!parsed.success) expect.fail(parsed.error.issues.map(i => i.message).join("; "));
    const detail = CanonicalChatDetailResponseSchema.parse(backend.detail());
    expect(detail.activities.some(a => a.type === "approval.resolved" && a.approvalId === "approval_apply_timer")).toBe(true);
  });

  it("resolves pending input requests through the canonical mutation contract", async () => {
    const { backend } = backendFor("clarification");
    const response = await post(
      backend.fetcher,
      `/api/chats/${FIXTURE_CHAT_ID}/runs/run_aoede_1/inputs/inputreq_timer_style`,
      { clientRequestId: "req_fixture_input", structuredAnswers: { q_cadence: ["Daily"] } },
    );
    expect(response.status).toBe(200);
    expect(CanonicalChatInputSubmissionResponseSchema.safeParse(await response.json()).success).toBe(true);
    const detail = CanonicalChatDetailResponseSchema.parse(backend.detail());
    expect(detail.activities.some(a => a.type === "input.resolved" && a.requestId === "inputreq_timer_style")).toBe(true);
  });

  it("cancels a pre-flight operation through the canonical action-cancel contract", async () => {
    const { backend } = backendFor("approval");
    const response = await post(
      backend.fetcher,
      `/api/chats/${FIXTURE_CHAT_ID}/actions/action_apply_timer/cancel`,
      {},
    );
    expect(response.status).toBe(200);
    const parsed = CanonicalChatActionCancellationResponseSchema.safeParse(await response.json());
    if (!parsed.success) expect.fail(parsed.error.issues.map(i => i.message).join("; "));
    expect(parsed.data.cancellation).toBe("cancelled");
    const detail = CanonicalChatDetailResponseSchema.parse(backend.detail());
    expect(detail.operations?.find(op => op.id === "action_apply_timer")?.state).toBe("cancelled");
  });

  it("reports terminal operations truthfully on cancel", async () => {
    const { backend } = backendFor("navigation-artifact");
    const response = await post(
      backend.fetcher,
      `/api/chats/${FIXTURE_CHAT_ID}/actions/action_apply_timer/cancel`,
      {},
    );
    const parsed = CanonicalChatActionCancellationResponseSchema.parse(await response.json());
    expect(parsed.cancellation).toBe("already_terminal");
  });

  it("records cancellation intent as 'requested' for in-flight operations", async () => {
    const { backend } = backendFor("tool-activity");
    const response = await post(
      backend.fetcher,
      `/api/chats/${FIXTURE_CHAT_ID}/actions/action_running_inspect/cancel`,
      {},
    );
    const parsed = CanonicalChatActionCancellationResponseSchema.parse(await response.json());
    expect(parsed.cancellation).toBe("requested");
    expect(parsed.operation.cancellationRequested).toBe(true);
    expect(parsed.operation.state).toBe("running");
  });

  it("can force the unproven 'unknown' cancellation outcome without mutating the operation", async () => {
    const evidence = createFixtureEvidence();
    const scenario = scenarioById("approval");
    const backend = createFixtureBackend({
      detail: scenario.detail(), bootstrap: scenario.bootstrap, evidence,
      forceActionCancellation: "unknown",
    });
    const before = CanonicalChatDetailResponseSchema.parse(backend.detail())
      .operations?.find(op => op.id === "action_apply_timer");
    const response = await post(
      backend.fetcher,
      `/api/chats/${FIXTURE_CHAT_ID}/actions/action_apply_timer/cancel`,
      {},
    );
    const parsed = CanonicalChatActionCancellationResponseSchema.parse(await response.json());
    expect(parsed.cancellation).toBe("unknown");
    expect(parsed.operation.state).toBe(before?.state);
    expect(parsed.operation.cancellationRequested).toBe(before?.cancellationRequested ?? false);
  });

  it("cancels an in-flight run through the canonical run-cancel contract", async () => {
    const { backend } = backendFor("tool-activity");
    const response = await post(
      backend.fetcher,
      `/api/chats/${FIXTURE_CHAT_ID}/runs/run_aoede_1/cancel`,
      { clientRequestId: "req_fixture_cancel" },
    );
    expect(response.status).toBe(200);
    const parsed = CanonicalChatRunCancellationResponseSchema.safeParse(await response.json());
    if (!parsed.success) expect.fail(parsed.error.issues.map(i => i.message).join("; "));
    expect(parsed.data.run.status).toBe("aborted");
  });

  it("updates selection through the canonical record contract", async () => {
    const { backend } = backendFor("listening");
    const detail = CanonicalChatDetailResponseSchema.parse(backend.detail());
    const response = await backend.fetcher(`https://fixture.test/api/chats/${FIXTURE_CHAT_ID}/selection`, {
      method: "PATCH",
      body: JSON.stringify({
        baseRevision: detail.record.chat.revision,
        selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
      }),
    });
    expect(response.status).toBe(200);
    expect(CanonicalChatRecordSchema.safeParse(await response.json()).success).toBe(true);
  });

  it("fails closed on unknown routes and foreign chat ids", async () => {
    const { backend } = backendFor("idle");
    const wrongChat = await backend.fetcher("https://fixture.test/api/chats/chat_other", {});
    expect(wrongChat.status).toBe(404);
    const unknown = await backend.fetcher("https://fixture.test/api/unknown", {});
    expect(unknown.status).toBe(404);
  });
});
