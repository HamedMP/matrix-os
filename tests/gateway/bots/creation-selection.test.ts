import { expect, it, vi } from "vitest";
import { MATRIX_BOT_SELECTION } from "@matrix-os/contracts";
import { createBotCreationSelectionValidator } from "../../../packages/gateway/src/bots/creation-selection.js";
import { BotInstantiationError } from "../../../packages/gateway/src/bots/instantiation.js";

it("admits exact Automatic creation intent without running inference or borrowing a subscription", async () => {
  const providers = { getSnapshot: vi.fn(async () => { throw new Error("no eligible source"); }) };
  const validate = createBotCreationSelectionValidator({ available: () => true, providers });
  await expect(validate("owner", MATRIX_BOT_SELECTION)).resolves.toBeUndefined();
  expect(providers.getSnapshot).not.toHaveBeenCalled();
});
it.each([
  { ...MATRIX_BOT_SELECTION, options: [{ id: "accountId", value: "foreign" }] },
  { ...MATRIX_BOT_SELECTION, model: "gpt" },
  { ...MATRIX_BOT_SELECTION, instanceId: "matrix_pi_chatgpt_plan" },
])("rejects malformed or ordinary-only Automatic intent before persistence", async selection => {
  const providers = { getSnapshot: vi.fn(async () => { throw new Error("unavailable"); }) };
  await expect(createBotCreationSelectionValidator({ available: () => true, providers })("owner", selection)).rejects.toBeInstanceOf(BotInstantiationError);
});
it("keeps unavailable host admission closed", async () => {
  await expect(createBotCreationSelectionValidator({ available: () => false, providers: { getSnapshot: vi.fn() } })("owner", MATRIX_BOT_SELECTION)).rejects.toMatchObject({ code: "unavailable" });
});
