import { describe, expect, it } from "vitest";
import { CanonicalProviderDriverKindSchema } from "../../packages/contracts/src/canonical-chat-primitives.js";
import { isChatAgentDriver } from "../../packages/contracts/src/chat-agent-context.js";
import { InstantiateBotRequestSchema } from "../../packages/contracts/src/bots/bot.js";
import { UpdateChatAgentRequestSchema } from "../../packages/contracts/src/chat-agents.js";

const request = {
  clientRequestId: "req_managed_pi_bot",
  recipe: { recipeId: "writing", version: "1" },
};
const selection = {
  instanceId: "matrix_pi_default",
  model: "cloudflare:@cf/zai-org/glm-5.3-flash",
};

describe("owned Pi managed selection contracts", () => {
  it("does not clear existing agent metadata when only its model is updated", () => {
    expect(UpdateChatAgentRequestSchema.parse({ baseRevision: 2, selection })).toEqual({ baseRevision: 2, selection });
    expect(UpdateChatAgentRequestSchema.parse({ baseRevision: 2, description: "" })).toEqual({ baseRevision: 2, description: "" });
  });
  it("distinguishes the managed Pi driver from the native coding CLI and kernel", () => {
    expect(CanonicalProviderDriverKindSchema.parse("matrix_pi")).toBe("matrix_pi");
    expect(isChatAgentDriver("matrix_pi")).toBe(true);
    expect(isChatAgentDriver("pi")).toBe(false);
    expect(isChatAgentDriver("kernel")).toBe(false);
  });

  it("preserves an optional concrete managed selection without choosing owner or bot identity", () => {
    expect(InstantiateBotRequestSchema.parse({ ...request, selection })).toEqual({ ...request, selection });
    expect(InstantiateBotRequestSchema.parse(request)).toEqual(request);
  });

  it("rejects arbitrary authority or duplicate selection options at the route boundary", () => {
    expect(InstantiateBotRequestSchema.safeParse({ ...request, selection, ownerId: "other_owner" }).success).toBe(false);
    expect(InstantiateBotRequestSchema.safeParse({ ...request,
      selection: { ...selection, accessSourceId: "owner_openai_profile" },
    }).success).toBe(false);
    expect(InstantiateBotRequestSchema.safeParse({ ...request,
      selection: { ...selection, options: [{ id: "effort", value: "low" }, { id: "effort", value: "high" }] },
    }).success).toBe(false);
  });
});
