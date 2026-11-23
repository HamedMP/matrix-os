import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { format } from "node:util";
import { CanonicalChatOrchestrationError } from "../../../packages/gateway/src/chat/orchestration-errors.js";
import { createRealBotStateDatabase, BOT, OWNER } from "./bot-state-support.js";
import { proposalFixture } from "./routine-cli-proposal-support.js";
import { proposal, scope, TARGET_A } from "./routine-cli-request-support.js";

const REQUEST_ID = "de000000-0000-4000-8000-000000000100";
const PRIVATE = "PRIVATE_DIAGNOSTIC_SENTINEL /private/credential token=never-log-this";
const WARNING = "[routine-cli-proposals] Canonical admission unconfirmed";
let data: Awaited<ReturnType<typeof createRealBotStateDatabase>> | undefined;
let fixture: Awaited<ReturnType<typeof proposalFixture>> | undefined;

beforeEach(async () => {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
  if (!url) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required for canonical admission diagnostics");
  data = await createRealBotStateDatabase(url);
  fixture = await proposalFixture(data.db, vi.fn);
});

afterEach(async () => {
  try { await fixture?.close(); }
  finally { fixture = undefined; await data?.destroy(); data = undefined; vi.restoreAllMocks(); }
});

it("correlates a real canonical catalog refusal while preserving unknown3 and never redispatching its UUID", async () => {
  expect.assertions(28);
  const f = fixture!;
  const bot = await f.agents.get({ type: "personal", ownerId: OWNER }, BOT);
  if (!bot) throw new Error("Required recipe Bot fixture is missing");
  // The real context/wrapper/catalog validator must refuse this absent model
  // before any canonical message, target task, runtime or provider is started.
  await f.agents.update({ type: "personal", ownerId: OWNER }, BOT, {
    baseRevision: bot.revision, selection: { instanceId: "matrix_pi_default", model: "unavailable-private-model" },
  });
  const actualAdmission = f.transport.admitTurn;
  let attempts = 0;
  let observed: unknown;
  f.transport.admitTurn = async (...args) => {
    attempts += 1;
    try { return await actualAdmission(...args); }
    catch (error: unknown) {
      observed = error;
      // Raw metadata is not the diagnostic contract, even on a genuine error.
      if (error instanceof Error) { error.message = PRIVATE; error.stack = PRIVATE; }
      throw error;
    }
  };
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const initial = await f.submit();
  expect(observed).toBeInstanceOf(CanonicalChatOrchestrationError);
  expect((observed as CanonicalChatOrchestrationError).safeError.code).toBe("provider_unavailable");
  expect(initial).toMatchObject({ receipt: { disposition: "queued", revision: 1 }, proposal: { handoff: "reserved", revision: 1 } });
  const dispatch = await f.db.selectFrom("routine_cli_proposals").selectAll()
    .where("client_request_id", "=", REQUEST_ID).executeTakeFirstOrThrow();
  expect(dispatch).toMatchObject({ stage: "unknown", run_id: null, task_id: null, interaction_id: null });
  expect(Number(dispatch.revision)).toBe(3);
  expect(dispatch.canonical_request_id).toMatch(/^req_cli_routine_[a-f0-9]{32}$/);
  for (const table of ["chat_queued_turns", "chat_turns", "chat_runs"] as const) {
    expect(await f.db.selectFrom(table).selectAll().where("chat_id", "=", TARGET_A.chatId)
      .where("client_request_id", "=", dispatch.canonical_request_id).execute()).toHaveLength(0);
  }
  for (const table of ["bot_tasks", "bot_approvals", "bot_routines"] as const) {
    expect(await f.db.selectFrom(table).selectAll().execute()).toHaveLength(0);
  }
  const read = await f.execute({ operation: "request", requestId: REQUEST_ID });
  const duplicate = await f.submit();
  for (const result of [read, duplicate]) {
    expect(result).toMatchObject({ receipt: { disposition: "queued", revision: 1 },
      proposal: { handoff: "unknown", revision: 3, approval: null, routine: null } });
  }
  expect(attempts).toBe(1);
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
  expect(f.host.createRuntime).not.toHaveBeenCalled();
  expect(f.runBot).not.toHaveBeenCalled();
  const warnings = warn.mock.calls.filter(([label]) => label === WARNING);
  expect(warnings).toHaveLength(1);
  expect(format(...warnings[0]!)).not.toContain("\n");
  expect(JSON.parse(warnings[0]![1] as string)).toEqual({ errorType: "CanonicalChatOrchestrationError", code: "provider_unavailable",
    canonicalRequestId: dispatch.canonical_request_id, requestId: REQUEST_ID });
  const encoded = JSON.stringify(warnings);
  for (const excluded of [PRIVATE, OWNER, BOT, TARGET_A.chatId, scope.computerId, proposal.prompt, "unavailable-private-model"]) {
    expect(encoded).not.toContain(excluded);
  }
});

it("logs a fixed generic category for an unexpected exception without serializing its name or impersonated safe code", async () => {
  expect.assertions(7);
  const f = fixture!;
  // Failure injection qualifies sanitization only; the real refusal above
  // retains the canonical admission and catalog boundary for its regression.
  f.transport.admitTurn = async () => {
    throw Object.assign(new Error(PRIVATE), { name: PRIVATE, stack: PRIVATE,
      safeError: { code: "authorization_failed", safeMessage: PRIVATE }, token: PRIVATE });
  };
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await f.submit();
  const dispatch = await f.db.selectFrom("routine_cli_proposals").selectAll()
    .where("client_request_id", "=", REQUEST_ID).executeTakeFirstOrThrow();
  expect(dispatch.stage).toBe("unknown");
  expect(Number(dispatch.revision)).toBe(3);
  const warnings = warn.mock.calls.filter(([label]) => label === WARNING);
  expect(warnings).toHaveLength(1);
  expect(format(...warnings[0]!)).not.toContain("\n");
  expect(JSON.parse(warnings[0]![1] as string)).toEqual({ errorType: "Error", canonicalRequestId: dispatch.canonical_request_id, requestId: REQUEST_ID });
  expect(JSON.stringify(warnings)).not.toContain(PRIVATE);
  expect(JSON.stringify(warnings)).not.toContain("authorization_failed");
});
