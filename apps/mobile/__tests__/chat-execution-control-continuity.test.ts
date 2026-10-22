import { defaultTurnModes } from "../lib/canonical-chat-selection";
import { createCanonicalProviderCatalogFixture } from "../../../tests/contracts/fixtures/canonical-chat";

it("uses accepted Chat controls only for the exact selection and supported modes", () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const selection = { instanceId: "codex_fixture", model: "gpt-5.6-sol" };
  const controls = { chatId: "chat_one", runId: "run_one", selection, interactionMode: "plan", permissionMode: "full_access" };
  expect(defaultTurnModes(catalog, selection, controls)).toEqual({ interactionMode: "plan", permissionMode: "full_access" });
  expect(defaultTurnModes(catalog, selection, { ...controls, selection: { ...selection, model: "another" } }))
    .toEqual({ interactionMode: "default", permissionMode: "supervised" });
  catalog.instances[0]!.supports.permissionModes = ["supervised"];
  expect(defaultTurnModes(catalog, selection, controls)?.permissionMode).toBe("supervised");
});
