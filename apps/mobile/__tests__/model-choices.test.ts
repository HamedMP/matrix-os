import {
  MATRIX_ENGINE_ID,
  chosenSelection,
  modelEngines,
  modelKey,
  modelNotices,
  modelTrigger,
  openingEngineId,
  selectionCanRun,
} from "../components/chat/model-choices";

import {
  API_KEY,
  GLM,
  GPT,
  PLAN,
  REASONING,
  SONNET,
  apiKeyBinding,
  apiKeyInstance,
  catalogOf,
  codexInstance,
  engineInstance,
  matrixInstance,
  planAgentInstance,
  planBinding,
  planInstance,
} from "./model-test-catalog";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

const hermes = () => engineInstance("hermes_default", "hermes", "Hermes", [["hermes-4", "Hermes 4"]]);
const heldMatrix = () => matrixInstance([[SONNET.model, "Sonnet 5", "unavailable"]], {
  availability: "unavailable",
  connectionState: "credit_reserved",
});

describe("the engines of the model sheet", () => {
  it("lists Matrix AI first, then the other engines in the catalog's order", () => {
    const engines = modelEngines(catalogOf(codexInstance(), hermes(), matrixInstance()), SONNET);

    expect(engines.map(({ id, label, logo }) => ({ id, label, logo }))).toEqual([
      { id: MATRIX_ENGINE_ID, label: "Matrix AI", logo: "matrix" },
      { id: "codex_default", label: "Codex", logo: "codex" },
      { id: "hermes_default", label: "Hermes", logo: "hermes" },
    ]);
  });

  it("offers only the engines the catalog lists", () => {
    expect(modelEngines(catalogOf(codexInstance()), GPT).map((engine) => engine.label)).toEqual(["Codex"]);
    expect(modelEngines(null, SONNET)).toEqual([]);
  });

  it("gathers Matrix's own routes under Matrix AI and tells them apart on the second line", () => {
    const [matrix, ...others] = modelEngines(catalogOf(
      matrixInstance(),
      engineInstance("matrix_pi_chatgpt_plan", "matrix_pi", "Pi", [["openai:gpt-5.6", "GPT-5.6"]]),
      engineInstance("kernel_default", "kernel", "Kernel", [[SONNET.model, "Sonnet 5"]], { connectionLabel: "Matrix AI" }),
    ), SONNET);

    expect(others).toEqual([]);
    expect(matrix!.models.map(({ name, detail, logo }) => ({ name, detail, logo }))).toEqual([
      { name: "Sonnet 5", detail: "Matrix AI", logo: "matrix" },
      { name: "GPT-5.6", detail: "Matrix AI · ChatGPT subscription", logo: "matrix" },
      { name: "Sonnet 5", detail: "Matrix AI · Kernel", logo: "matrix" },
    ]);
  });

  it("builds an agent engine's second line from its connection label and its name", () => {
    const [plain] = modelEngines(catalogOf(codexInstance()), null);
    const [connected] = modelEngines(catalogOf(codexInstance(undefined, { connectionLabel: "ChatGPT Plus" })), null);

    expect(plain!.models[0]).toMatchObject({ name: "GPT-5.6-Sol", detail: "Codex", logo: "codex" });
    expect(connected!.models[0]).toMatchObject({ detail: "ChatGPT Plus · Codex" });
  });

  it("checks the selection's model and no other", () => {
    const engines = modelEngines(catalogOf(
      matrixInstance([[SONNET.model, "Sonnet 5"], [GLM.model, "GLM Flash"]]),
      codexInstance(),
    ), GLM);

    expect(engines.flatMap((engine) => engine.models).filter((model) => model.selected).map((model) => model.key))
      .toEqual([modelKey(GLM.instanceId, GLM.model)]);
  });

  it("keeps a model that cannot run in the list, saying why, and not available", () => {
    const [matrix] = modelEngines(catalogOf(
      matrixInstance([[SONNET.model, "Sonnet 5"], [GLM.model, "GLM Flash", "unavailable"]]),
    ), SONNET);
    expect(matrix!.models.map(({ detail, available }) => ({ detail, available }))).toEqual([
      { detail: "Matrix AI", available: true },
      { detail: "Matrix AI · Model unavailable", available: false },
    ]);

    const [held] = modelEngines(catalogOf(heldMatrix()), SONNET);
    expect(held!.models[0]).toMatchObject({ detail: "Matrix AI · Credit reserved", available: false, selected: true });

    const [signedOut] = modelEngines(catalogOf(codexInstance(undefined, { availability: "auth_required" })), null);
    expect(signedOut!.models[0]).toMatchObject({ detail: "Codex · Authentication required", available: false });

    const [switchedOff] = modelEngines(catalogOf(codexInstance(undefined, {
      availability: "unavailable",
      unavailabilityReason: "disabled_in_settings",
    })), null);
    expect(switchedOff!.models[0]).toMatchObject({ detail: "Codex · Disabled in Settings", available: false });
  });

  it("says why an engine has nothing that can run, and nothing when it has", () => {
    const [matrix, codex, empty] = modelEngines(catalogOf(
      matrixInstance(),
      codexInstance([], { availability: "setup_required" }),
      engineInstance("opencode_default", "opencode", "OpenCode", []),
    ), SONNET);

    expect(matrix!.note).toBeNull();
    expect(codex).toMatchObject({ models: [], note: "Setup required" });
    expect(empty).toMatchObject({ models: [], note: "Models unavailable" });
    expect(modelEngines(catalogOf(heldMatrix()), SONNET)[0]!.note).toBe("Matrix AI credit reserved");
  });

  it("omits the retired Matrix SDK route", () => {
    const engines = modelEngines(catalogOf(
      engineInstance("kernel_matrix_included", "kernel", "Claude SDK", [[SONNET.model, "SDK duplicate"]]),
      matrixInstance(),
    ), SONNET);

    expect(engines.flatMap((engine) => engine.models).map((model) => model.name)).toEqual(["Sonnet 5"]);
  });

  it("leaves out a route that only agents run on", () => {
    const catalog = catalogOf(matrixInstance(), planAgentInstance(), planInstance());
    const [matrix, ...others] = modelEngines(catalog, SONNET);

    expect(others).toEqual([]);
    expect(matrix!.models.map(({ name, detail }) => ({ name, detail }))).toEqual([
      { name: "Sonnet 5", detail: "Matrix AI" },
      { name: "GPT-5.6-Sol", detail: "Matrix AI · ChatGPT subscription" },
    ]);
    expect(modelEngines(catalogOf(planAgentInstance()), null)).toEqual([]);
    expect(modelTrigger(catalogOf(planAgentInstance()), null, false).canChoose).toBe(false);
  });

  it("keeps a saved model the catalog no longer lists: first in its engine, checked, not available", () => {
    const missing = { ...SONNET, model: "anthropic:revoked-model" };
    const [matrix] = modelEngines(catalogOf(matrixInstance()), missing);

    expect(matrix!.models).toEqual([
      {
        key: modelKey(missing.instanceId, missing.model),
        name: "anthropic:revoked-model",
        detail: "Matrix AI · unavailable",
        logo: "matrix",
        selected: true,
        available: false,
      },
      expect.objectContaining({ name: "Sonnet 5", selected: false, available: true }),
    ]);
  });

  it("leaves a saved model out when its engine is not offered at all", () => {
    const engines = modelEngines(catalogOf(matrixInstance()), { instanceId: "gone_default", model: "gone" });

    expect(engines.flatMap((engine) => engine.models).map((model) => model.name)).toEqual(["Sonnet 5"]);
  });

  it("opens on the selection's engine, otherwise on the first that has a model to run", () => {
    const catalog = catalogOf(matrixInstance([[SONNET.model, "Sonnet 5", "unavailable"]]), codexInstance());

    expect(openingEngineId(modelEngines(catalog, GPT))).toBe("codex_default");
    expect(openingEngineId(modelEngines(catalog, SONNET))).toBe(MATRIX_ENGINE_ID);
    expect(openingEngineId(modelEngines(catalog, null))).toBe("codex_default");
    expect(openingEngineId(modelEngines(catalogOf(heldMatrix()), null))).toBe(MATRIX_ENGINE_ID);
    expect(openingEngineId([])).toBeNull();
  });
});

describe("the model trigger's state", () => {
  it("names the engine before the model, under the engine's logo", () => {
    expect(modelTrigger(catalogOf(matrixInstance()), SONNET, false))
      .toEqual({ provider: "matrix", label: "Matrix AI · Sonnet 5", canChoose: true });
    expect(modelTrigger(catalogOf(codexInstance()), GPT, false))
      .toEqual({ provider: "codex", label: "Codex · GPT-5.6-Sol", canChoose: true });
  });

  it("marks a saved model that cannot run, and one that is still being checked", () => {
    const switchedOff = catalogOf(matrixInstance(undefined, { availability: "unavailable" }));

    expect(modelTrigger(switchedOff, SONNET, false))
      .toEqual({ provider: "matrix", label: "Matrix AI · Sonnet 5 · unavailable", canChoose: false });
    expect(modelTrigger(null, SONNET, false))
      .toEqual({ provider: undefined, label: `${SONNET.model} · checking`, canChoose: false });
  });

  it("does not mark a saved model whose credit is held", () => {
    expect(modelTrigger(catalogOf(heldMatrix()), SONNET, false))
      .toEqual({ provider: "matrix", label: "Matrix AI · Sonnet 5", canChoose: false });
  });

  it("asks for a choice, or says the models are being checked, when nothing is chosen", () => {
    expect(modelTrigger(null, null, true).label).toBe("Checking models…");
    expect(modelTrigger(null, null, false).label).toBe("Choose a model");
  });
});

describe("the notices under the model trigger", () => {
  it("has none for a selection that can run", () => {
    expect(modelNotices(catalogOf(matrixInstance()), SONNET, false))
      .toEqual({ reserved: [], unavailable: [], recovery: null });
  });

  it("lists the models whose credit is held", () => {
    expect(modelNotices(catalogOf(heldMatrix()), null, false).reserved)
      .toEqual([{ key: modelKey(SONNET.instanceId, SONNET.model), text: "Sonnet 5 · Matrix AI · Credit reserved" }]);
  });

  it("lists the models of a running engine that cannot run themselves", () => {
    const catalog = catalogOf(matrixInstance([[SONNET.model, "Sonnet 5"], [GLM.model, "GLM Flash", "unavailable"]]));

    expect(modelNotices(catalog, SONNET, false).unavailable)
      .toEqual([{ key: modelKey(GLM.instanceId, GLM.model), text: "GLM Flash · Matrix AI · Model unavailable" }]);
  });

  it("gives the engine's reason when the saved model's engine cannot run", () => {
    const catalog = catalogOf(matrixInstance(undefined, {
      availability: "unavailable",
      unavailabilityReason: "disabled_in_settings",
    }));

    expect(modelNotices(catalog, SONNET, false).recovery)
      .toBe("Disabled in Settings. Choose another model or check Agents & providers.");
  });

  it("says the saved model is unavailable when the catalog no longer lists it", () => {
    expect(modelNotices(catalogOf(matrixInstance()), { ...SONNET, model: "anthropic:revoked-model" }, false).recovery)
      .toBe("Saved model unavailable. Choose another model or check Agents & providers.");
  });

  it("says the saved model is being checked before the catalog arrives, but not while it loads", () => {
    expect(modelNotices(null, SONNET, false).recovery)
      .toBe("Checking model availability. Choose another model or check Agents & providers.");
    expect(modelNotices(null, SONNET, true).recovery).toBeNull();
  });
});

describe("choosing a model", () => {
  const catalog = catalogOf(
    engineInstance("kernel_matrix_included", "kernel", "Claude SDK", [["sdk", "SDK duplicate"]]),
    matrixInstance([[SONNET.model, "Sonnet 5"], [GLM.model, "GLM Flash", "unavailable"]]),
    codexInstance(undefined, { availability: "auth_required" }),
  );

  it("gives the selection of a model that can run", () => {
    expect(chosenSelection(catalog, modelKey(SONNET.instanceId, SONNET.model))).toEqual(SONNET);
  });

  it("carries the value the engine names for each of its options, and none for an option without one", () => {
    const { defaultValue: _default, ...unnamed } = REASONING;
    const options = [REASONING, { ...unnamed, id: "tone", label: "Tone" }, { ...REASONING, id: "tier", label: "Tier", defaultValue: "low" }];
    const named = [{ id: "effort", value: "medium" }, { id: "tier", value: "low" }];
    const other = { ...GPT, model: "gpt-5.6-terra" };
    const withDefault = catalogOf(codexInstance([[GPT.model, "GPT-5.6-Sol"], [other.model, "GPT-5.6-Terra"]], {
      options,
      defaultSelection: { ...GPT, options: [{ id: "effort", value: "high" }] },
    }));

    // The default selection's values are for its own model only.
    expect(chosenSelection(withDefault, modelKey(GPT.instanceId, GPT.model)))
      .toEqual({ ...GPT, options: [{ id: "effort", value: "high" }, { id: "tier", value: "low" }] });
    expect(chosenSelection(withDefault, modelKey(other.instanceId, other.model))).toEqual({ ...other, options: named });
  });

  it("binds a model run through the person's own subscription to the account the catalog lists", () => {
    const other = { ...PLAN, model: "gpt-5.6-terra" };
    const plan = catalogOf(planInstance([[PLAN.model, "GPT-5.6-Sol"], [other.model, "GPT-5.6-Terra"]]));

    expect(chosenSelection(plan, modelKey(PLAN.instanceId, PLAN.model))).toEqual({ ...PLAN, options: planBinding() });
    expect(chosenSelection(plan, modelKey(other.instanceId, other.model))).toEqual({ ...other, options: planBinding() });
  });

  it("gives nothing for a route that only agents run on", () => {
    expect(chosenSelection(catalogOf(planAgentInstance()), modelKey("matrix_chatgpt_plan", PLAN.model))).toBeNull();
  });

  it("gives nothing for a model that cannot run, a retired route or an unknown key", () => {
    expect(chosenSelection(catalog, modelKey(GLM.instanceId, GLM.model))).toBeNull();
    expect(chosenSelection(catalog, modelKey(GPT.instanceId, GPT.model))).toBeNull();
    expect(chosenSelection(catalog, modelKey("kernel_matrix_included", "sdk"))).toBeNull();
    expect(chosenSelection(catalog, modelKey("gone_default", "gone"))).toBeNull();
    expect(chosenSelection(catalog, "not-a-key")).toBeNull();
    expect(chosenSelection(null, modelKey(SONNET.instanceId, SONNET.model))).toBeNull();
  });
});

describe("a saved model run through the person's own subscription", () => {
  const catalog = catalogOf(planInstance());
  const bound = { ...PLAN, options: planBinding() };
  // As saved before the account was connected again, and as a build that left the account out saved it.
  const outdated = [{ ...PLAN, options: planBinding("acct_first", "0") }, { ...PLAN, options: planBinding("acct_other") }, PLAN];

  it("can run while it is bound to the account the catalog lists", () => {
    expect(selectionCanRun(catalog, bound)).toBe(true);
    expect(modelTrigger(catalog, bound, false).label).toBe("Matrix AI · ChatGPT subscription · GPT-5.6-Sol");
    expect(modelNotices(catalog, bound, false).recovery).toBeNull();
  });

  it("cannot run once that account has been replaced, or when it was saved without one", () => {
    for (const saved of outdated) {
      expect(selectionCanRun(catalog, saved)).toBe(false);
      expect(modelTrigger(catalog, saved, false).label).toBe("Matrix AI · ChatGPT subscription · GPT-5.6-Sol · unavailable");
    }
  });

  it("stays in the list, checked, so that it can be chosen again, and says to do so", () => {
    for (const saved of outdated) {
      expect(modelEngines(catalog, saved)[0]!.models).toEqual([
        expect.objectContaining({ key: modelKey(PLAN.instanceId, PLAN.model), selected: true, available: true }),
      ]);
      expect(modelNotices(catalog, saved, false).recovery)
        .toBe("Connection changed. Choose the model again or check Agents & providers.");
    }
  });

  it("is an unavailable saved model like any other once the account is disconnected", () => {
    const disconnected = catalogOf(planInstance([], [], { availability: "unavailable" }));

    expect(selectionCanRun(disconnected, bound)).toBe(false);
    expect(modelNotices(disconnected, bound, false).recovery)
      .toBe("Saved model unavailable. Choose another model or check Agents & providers.");
  });

  it("is bound the same way when the account is the person's own Anthropic API key", () => {
    const keyed = catalogOf(apiKeyInstance());
    const chosen = chosenSelection(keyed, modelKey(API_KEY.instanceId, API_KEY.model));

    expect(chosen).toEqual({ ...API_KEY, options: apiKeyBinding() });
    expect(selectionCanRun(keyed, chosen)).toBe(true);
    // A key replaced since, and a selection saved without one.
    expect(selectionCanRun(keyed, { ...API_KEY, options: apiKeyBinding("7c9e6679-7425-40de-944b-e07fc1f90ae7") })).toBe(false);
    expect(selectionCanRun(keyed, API_KEY)).toBe(false);
    expect(modelNotices(keyed, API_KEY, false).recovery)
      .toBe("Connection changed. Choose the model again or check Agents & providers.");
  });
});
