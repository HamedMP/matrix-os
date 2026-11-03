import { expect, it } from "vitest";
import { agentEditorValidation } from "../../../packages/ui/src/chat-agents/agent-editor-validation.js";
import { deriveCanonicalProviderChoices } from "../../../packages/ui/src/canonical-provider-choice.js";
import { clientFixture, recipeCatalog, saved } from "../../desktop/chat-agents-fixture.js";

async function fixture() {
  const catalog = await clientFixture({ matrix: true }).catalog();
  return { draft: { name: "A Bot", description: "", instructions: "Prepare reports", requestId: "req_validation01",
    selection: { instanceId: "matrix_pi_default", model: "sonnet" } }, editing: "new" as const,
    catalog, models: deriveCanonicalProviderChoices(catalog), recipeCatalog };
}
it("derives all missing required fields and model loading from the same submission result", async () => {
  const x = await fixture();
  const result = agentEditorValidation({ ...x, draft: { ...x.draft, name: " ", instructions: " ", selection: null } });
  expect(result.valid).toBe(false); expect(Object.keys(result.errors)).toEqual(["name", "instructions", "model"]);
  expect(agentEditorValidation({ ...x, catalogLoading: true }).errors.model).toContain("loading");
  expect(agentEditorValidation(x).valid).toBe(true);
});
it("blocks unavailable skills, oversized selections and invalid integration payloads with safe feedback", async () => {
  const x = await fixture(), recipe = { skills: ["missing-skill"], integrations: [], output: "A report" };
  expect(agentEditorValidation({ ...x, draft: { ...x.draft, recipe } }).errors.recipe).toContain("unavailable");
  const oversized = { ...recipe, skills: ["matrix-integrations", "matrix-personal-daily-brief"] };
  const largeCatalog = { ...recipeCatalog, skills: recipeCatalog.skills.map(skill => ({ ...skill, instructionBytes: 20_000 })) };
  expect(agentEditorValidation({ ...x, recipeCatalog: largeCatalog, draft: { ...x.draft, recipe: oversized } }).errors.recipe).toContain("too large");
  const invalid = { ...recipe, skills: [], integrations: [{ service: "private/raw-invalid" }] };
  const validation = agentEditorValidation({ ...x, draft: { ...x.draft, recipe: invalid } });
  expect(validation.valid).toBe(false); expect(validation.errors.recipe).not.toContain("private/");
});
it("preserves an unchanged unavailable saved model and recipe during text-only recovery", async () => {
  const x = await fixture(), recipe = { skills: ["missing-skill"], integrations: [], output: "A report" };
  const editing = { ...saved, recipe };
  expect(agentEditorValidation({ ...x, editing, draft: { ...x.draft, selection: saved.selection, recipe },
    catalogLoading: true, models: [], recipeCatalog: null }).valid).toBe(true);
});

it("blocks incompatible source changes while either generic or managed creation outcome is retained", async () => {
  const x = await fixture();
  const generic = agentEditorValidation({ ...x, managedCreation: true, retainedManaged: false,
    retainedSelection: saved.selection });
  expect(generic.valid).toBe(false); expect(generic.errors.model).toContain("original model");
  const restoreGeneric = agentEditorValidation({ ...x, managedCreation: true, retainedManaged: false,
    retainedSelection: saved.selection, draft: { ...x.draft, selection: saved.selection } });
  expect(restoreGeneric.valid).toBe(true);
  const managed = agentEditorValidation({ ...x, managedCreation: true, retainedManaged: true,
    retainedSelection: x.draft.selection, draft: { ...x.draft, selection: saved.selection } });
  expect(managed.valid).toBe(false); expect(managed.errors.model).toContain("original model");
  expect(agentEditorValidation({ ...x, managedCreation: true, retainedManaged: true,
    retainedSelection: x.draft.selection }).valid).toBe(true);
});
