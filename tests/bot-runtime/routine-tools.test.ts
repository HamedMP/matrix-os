import { expect, it, vi } from "vitest";
import { createBotTools } from "../../packages/bot-runtime/src/tools.js";
import { BotToolRequestSchema } from "@matrix-os/contracts";
it("only advertises routine proposal and controls when server admitted; proposal waits for approval", async () => {
  const tool = vi.fn(async () => ({
      ok: true,
      content: [{
        type: "text",
        text: "approval pending"
      }]
    })),
    state = {
      waitingForPerson: false,
      effectUnknown: false
    };
  const tools = createBotTools({
    capabilities: ["routine.propose", "routine.control"],
    broker: {
      tool
    } as never,
    state,
    routineModel: "fixture"
  });
  expect(tools.map(t => t.name)).toEqual(["propose_routine", "routine_control"]);
  expect(tools[1].parameters).toMatchObject({
    type: "object"
  });
  expect(createBotTools({
    capabilities: [],
    broker: {
      tool
    } as never,
    state
  }).map(t => t.name)).not.toContain("propose_routine");
  await tools[0].execute("routine_fixture", {
    name: "Fixture",
    prompt: "Read fixture",
    schedule: {
      kind: "interval",
      everyMs: 60000
    },
    selection: {
      instanceId: "matrix_chatgpt_plan",
      model: "fixture"
    },
    authorizedEffects: ["read"]
  });
  expect(state.waitingForPerson).toBe(true);
  expect(tool).toHaveBeenCalledTimes(1);
});

it("builds a natural-language proposal with the admitted model instead of asking the model to choose its own binding", async () => {
  let request: unknown;
  const tools = createBotTools({ capabilities: ["routine.propose"], routineModel: "gpt-6-luna",
    broker: { tool: async (value: unknown) => { request = BotToolRequestSchema.parse(value); return { ok: true, content: [{ type: "text", text: "approval pending" }] }; } } as never,
    state: { waitingForPerson: false, effectUnknown: false } });
  expect((tools[0].parameters as { required: string[] }).required).not.toContain("selection");
  await tools[0].execute("routine_natural", { name: "Fixed reply", prompt: "Reply OK", schedule: { kind: "interval", everyMs: 60000 }, authorizedEffects: ["read"] });
  expect(request).toMatchObject({ capability: "routine.propose", args: { selection: { instanceId: "matrix_chatgpt_plan", model: "gpt-6-luna" } } });
});

it("does not advertise proposal creation without a trusted admitted model", () => {
  const tools = createBotTools({ capabilities: ["routine.propose", "routine.control"], broker: {} as never,
    state: { waitingForPerson: false, effectUnknown: false } });
  expect(tools.map(tool => tool.name)).toEqual(["routine_control"]);
});

it("never lets a supplied proposal selection override the admitted source/model", async () => {
  let request: unknown;
  const tool = createBotTools({ capabilities: ["routine.propose"], routineModel: "gpt-6-luna",
    broker: { tool: async (value: unknown) => { request = BotToolRequestSchema.parse(value); return {ok: true, content: []}; } } as never,
    state: { waitingForPerson: false, effectUnknown: false } })[0];
  await tool.execute("routine_forged_model", { name: "Fixture", prompt: "Reply OK", schedule: {kind: "interval", everyMs: 60000},
    selection: {instanceId: "foreign", model: "Bot display name"}, authorizedEffects: ["read"] });
  expect(request).toMatchObject({args: {selection: {instanceId: "matrix_chatgpt_plan", model: "gpt-6-luna"}}});
});
