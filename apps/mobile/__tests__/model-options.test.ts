import { modelOptionGroups, selectionWithOption } from "../components/chat/model-options";

import { REASONING, SONNET, catalogOf, matrixInstance, type Instance } from "./model-test-catalog";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

function withOptions(options: Instance["options"], overrides: Partial<Instance> = {}) {
  return catalogOf(matrixInstance(undefined, { options, ...overrides }));
}

function chosen(groups: ReturnType<typeof modelOptionGroups>) {
  return groups.map((group) => group.values.filter((value) => value.selected).map((value) => value.value));
}

describe("the options of the selected model", () => {
  it("offers the engine's composer choice under the option's own name, with the default marked", () => {
    expect(modelOptionGroups(withOptions([REASONING]), SONNET)).toEqual([{
      id: "effort",
      label: "Reasoning",
      values: [
        { value: "low", label: "Low", selected: false },
        { value: "medium", label: "Medium", selected: true },
        { value: "high", label: "High", selected: false },
      ],
    }]);
  });

  it("marks the value saved with the selection over the default", () => {
    const saved = { ...SONNET, options: [{ id: "effort", value: "high" }] };

    expect(chosen(modelOptionGroups(withOptions([REASONING]), saved))).toEqual([["high"]]);
  });

  it("marks nothing when no value is saved and the option has no default", () => {
    const { defaultValue: _default, ...noDefault } = REASONING;

    expect(chosen(modelOptionGroups(withOptions([noDefault]), SONNET))).toEqual([[]]);
  });

  it("has none when the engine offers no option", () => {
    expect(modelOptionGroups(withOptions([]), SONNET)).toEqual([]);
  });

  it("leaves out advanced options, switches and options with a single value", () => {
    const groups = modelOptionGroups(withOptions([
      { ...REASONING, id: "service_tier", label: "Service tier", placement: "advanced" },
      { id: "fast", label: "Fast mode", kind: "boolean", placement: "composer" },
      { ...REASONING, id: "only", label: "Only", defaultValue: "low", values: [{ value: "low", label: "Low" }] },
    ]), SONNET);

    expect(groups).toEqual([]);
  });

  it("has none for a selection that cannot run, or before there is one", () => {
    expect(modelOptionGroups(withOptions([REASONING], { availability: "unavailable" }), SONNET)).toEqual([]);
    expect(modelOptionGroups(withOptions([REASONING]), { ...SONNET, model: "anthropic:revoked-model" })).toEqual([]);
    expect(modelOptionGroups(withOptions([REASONING]), null)).toEqual([]);
    expect(modelOptionGroups(null, SONNET)).toEqual([]);
  });
});

describe("saving an option with the selection", () => {
  it("adds the value to a selection that had none", () => {
    expect(selectionWithOption(SONNET, "effort", "high")).toEqual({ ...SONNET, options: [{ id: "effort", value: "high" }] });
  });

  it("replaces that option's value and keeps the others", () => {
    const saved = { ...SONNET, options: [{ id: "effort", value: "low" }, { id: "service_tier", value: "fast" }] };

    expect(selectionWithOption(saved, "effort", "high")).toEqual({
      ...SONNET,
      options: [{ id: "service_tier", value: "fast" }, { id: "effort", value: "high" }],
    });
  });
});
