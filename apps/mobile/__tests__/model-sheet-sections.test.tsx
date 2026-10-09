import { cleanup, fireEvent, screen, within } from "@testing-library/react-native";
import { Platform } from "react-native";

import { chip, claude, codex, reasoning, renderSheet } from "./model-sheet-test-utils";
import { flat } from "./ui-test-utils";

afterEach(cleanup);

describe("while the models are being checked", () => {
  it("says so beside the title and lets nothing be chosen", () => {
    const { onSelectModel, onSelectOption } = renderSheet({ loading: true, options: [reasoning] });

    expect(screen.getByLabelText("Checking model availability")).toBeTruthy();
    for (const node of within(screen.getByTestId("model-sheet-models")).getAllByRole("button")) {
      expect(node.props.accessibilityState).toMatchObject({ disabled: true });
      fireEvent.press(node);
    }
    fireEvent.press(screen.getByRole("button", { name: "Low" }));
    expect(onSelectModel).not.toHaveBeenCalled();
    expect(onSelectOption).not.toHaveBeenCalled();
  });

  it("says nothing beside the title otherwise", () => {
    renderSheet();

    expect(screen.queryByLabelText("Checking model availability")).toBeNull();
  });
});

describe("the selected model's option", () => {
  it("adds a section under the option's own name, with a chip per value and the current one selected", () => {
    renderSheet({ options: [reasoning] });

    expect(screen.getByRole("header", { name: "Reasoning" })).toBeTruthy();
    const values = screen.getByTestId("model-sheet-option-effort");
    expect(values.props.horizontal).toBe(true);
    expect(within(values).getAllByRole("button").map((node) => [node.props.accessibilityLabel, node.props.accessibilityState.selected]))
      .toEqual([["Low", false], ["Medium", true]]);
  });

  it("reports the value that is tapped", () => {
    const { onSelectOption, onSelectModel } = renderSheet({ options: [reasoning] });

    fireEvent.press(screen.getByRole("button", { name: "Low" }));

    expect(onSelectOption).toHaveBeenCalledWith("effort", "low");
    expect(onSelectModel).not.toHaveBeenCalled();
  });

  it("has no such section when the model has no option", () => {
    renderSheet();

    expect(screen.queryByRole("header", { name: "Reasoning" })).toBeNull();
    expect(screen.getAllByRole("header").map((node) => node.props.children)).toEqual(["Choose model", "Run with", "Model"]);
  });

  it("is put away while another engine's models are shown, since it belongs to the selected model", () => {
    renderSheet({ options: [reasoning] });

    fireEvent.press(chip("Claude Code"));
    expect(screen.queryByRole("header", { name: "Reasoning" })).toBeNull();

    fireEvent.press(chip("Matrix AI"));
    expect(screen.getByRole("header", { name: "Reasoning" })).toBeTruthy();
  });
});

describe("the credit box", () => {
  it("shows the balance on one line in a hairline box when Matrix AI is the engine shown", () => {
    renderSheet({ credit: "$18.40" });

    expect(flat(screen.getByTestId("model-sheet-credit"))).toMatchObject({
      borderWidth: 1,
      borderColor: "#F3F2F2",
      borderRadius: 14,
      paddingHorizontal: 14,
      paddingVertical: 12,
    });
    expect(flat(screen.getByText("$18.40 credit"))).toMatchObject({
      fontFamily: "Geist_500Medium",
      fontSize: 14,
      lineHeight: 20,
      color: "#242323",
    });
    expect(within(screen.getByTestId("model-sheet-credit")).getAllByText(/./)).toHaveLength(1);
  });

  it("holds its place while the balance loads, with a skeleton as tall as the amount's line", () => {
    renderSheet({ credit: null, creditLoading: true });

    const box = screen.getByTestId("model-sheet-credit");
    expect(flat(box)).toMatchObject({ borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12 });
    expect(within(box).queryAllByText(/./)).toEqual([]);
    const placeholder = flat(within(box).getByTestId("model-sheet-credit-loading"));
    expect(placeholder).toMatchObject({ height: 14, marginVertical: 3, borderRadius: 6 });
    // The amount's line is 20pt high, so the sheet does not grow when it arrives.
    expect((placeholder.height as number) + 2 * (placeholder.marginVertical as number)).toBe(20);
    expect(placeholder.width).toBeUndefined();
  });

  it("shows the amount in place of the skeleton as soon as there is one", () => {
    renderSheet({ credit: "$18.40", creditLoading: true });

    expect(screen.getByText("$18.40 credit")).toBeTruthy();
    expect(screen.queryByTestId("model-sheet-credit-loading")).toBeNull();
  });

  it("is left out when the balance could not be read or there is none", () => {
    renderSheet({ credit: null, creditLoading: false });

    expect(screen.queryByTestId("model-sheet-credit")).toBeNull();
    expect(screen.queryByText(/credit/i)).toBeNull();
  });

  it("is left out while another engine is shown, and when the catalog offers no Matrix AI", () => {
    renderSheet({ credit: "$18.40" });
    fireEvent.press(chip("Claude Code"));
    expect(screen.queryByTestId("model-sheet-credit")).toBeNull();
    cleanup();

    renderSheet({ credit: null, creditLoading: true });
    fireEvent.press(chip("Claude Code"));
    expect(screen.queryByTestId("model-sheet-credit")).toBeNull();
    cleanup();

    renderSheet({ credit: "$18.40", creditLoading: true, engines: [claude, codex] });
    expect(screen.queryByTestId("model-sheet-credit")).toBeNull();
  });
});

// docs/dev/mobile-shell.md, "Store Purchase Policy": a native build carries
// no purchase call to action. The frame's Buy credit button and its "No
// subscription needed" line are therefore not built.
describe("in native store builds", () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(["ios", "android"] as const)("shows the balance read-only with nothing to buy on %s", (os) => {
    jest.replaceProperty(Platform, "OS", os);
    renderSheet({ credit: "$18.40", options: [reasoning] });

    expect(screen.getByText("$18.40 credit")).toBeTruthy();
    expect(screen.queryByText(/buy|purchase|subscri|pricing|upgrade|checkout|top up|add credit|plan\b|browser|website|matrix-os\.com/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /buy|purchase|subscri|pricing|upgrade|checkout|top up|credit/i })).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    // Every control in the sheet is an engine, a model or an option value.
    expect(screen.getAllByRole("button").map((node) => node.props.accessibilityLabel)).toEqual([
      "Matrix AI", "Claude Code", "Codex, Authentication required",
      "Claude Sonnet 5, Matrix AI", "GLM, Matrix AI", "GF1, Matrix AI · Model unavailable",
      "Low", "Medium",
    ]);
  });
});
