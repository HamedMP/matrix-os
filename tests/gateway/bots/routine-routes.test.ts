import type { BotRoutineExecution } from "../../../packages/gateway/src/bots/routine-execution.js";
import { expect, it, vi } from "vitest";
import { createBotRoutes } from "../../../packages/gateway/src/bots/routes.js";
import { BotStateError } from "../../../packages/gateway/src/bots/repositories/shared.js";
const BOT = "bot_0123456789abcdef01234567",
  RT = "rt_0123456789abcdef01234567",
  OWNER = "fixture-owner";
function setup() {
  const record = {
    routineId: RT,
    ownerId: OWNER,
    botId: BOT,
    chatId: "chat_fixture",
    proposal: {
      name: "Fixture",
      prompt: "Fixture",
      schedule: {
        kind: "interval" as const,
        everyMs: 60000
      },
      selection: {
        instanceId: "matrix_chatgpt_plan" as const,
        model: "fixture"
      },
      authorizedEffects: ["read" as const]
    },
    authorization: null,
    approvalId: null,
    status: "paused" as const,
    nextFireAt: null,
    revision: 2,
    createdAt: "2026-09-27T12:00:00.000Z",
    updatedAt: "2026-09-27T12:00:00.000Z"
  };
  const routines = {
    list: vi.fn<BotRoutineExecution["list"]>(async () => [{
      routineId: RT,
      name: record.proposal.name,
      schedule: record.proposal.schedule,
      status: record.status,
      nextFireAt: null,
      revision: 2,
      lastFire: null,
      requiresReview: false
    }]),
    control: vi.fn<BotRoutineExecution["control"]>(async () => record)
  };
  return {
    routines,
    app: createBotRoutes({
      routines,
      getPrincipal: () => ({
        userId: OWNER,
        source: "jwt"
      })
    })
  };
}
it("reads durable routine status only in the principal's owner scope", async () => {
  const {
    app,
    routines
  } = setup();
  const response = await app.request(`/api/chat-agents/${BOT}/routines`);
  expect(response.status).toBe(200);
  expect(routines.list).toHaveBeenCalledWith(OWNER, BOT);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it("validates control IDs, revisions and owner injection before dispatch", async () => {
  const {
    app,
    routines
  } = setup();
  for (const [id, body] of [[RT, {
    status: "paused",
    baseRevision: 0
  }], ["invalid", {
    status: "paused",
    baseRevision: 1
  }], [RT, {
    status: "paused",
    baseRevision: 1,
    ownerId: "foreign"
  }]]) {
    const response = await app.request(`/api/chat-agents/${BOT}/routines/${id}/control`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    expect(response.status).toBe(400);
  }
  expect(routines.control).not.toHaveBeenCalled();
});
it("bounds mutations and maps stale revisions to a safe conflict", async () => {
  const {
    app,
    routines
  } = setup();
  let response = await app.request(`/api/chat-agents/${BOT}/routines/${RT}/control`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: "x".repeat(70000)
  });
  expect(response.status).toBe(413);
  expect(routines.control).not.toHaveBeenCalled();
  routines.control.mockRejectedValue(new BotStateError("revision_conflict"));
  response = await app.request(`/api/chat-agents/${BOT}/routines/${RT}/control`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      status: "paused",
      baseRevision: 1
    })
  });
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("Bot state operation");
});
it("reports missing routine service as unavailable", async () => {
  const app = createBotRoutes({
    getPrincipal: () => ({
      userId: OWNER,
      source: "jwt"
    })
  });
  expect((await app.request(`/api/chat-agents/${BOT}/routines`)).status).toBe(503);
});
