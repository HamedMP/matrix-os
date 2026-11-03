import { expect, it, vi } from "vitest";
import { createBotTools } from "../../packages/bot-runtime/src/tools.js";
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
    state
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
