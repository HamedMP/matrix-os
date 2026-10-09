import type { ReactNode } from "react";
import { act, cleanup, fireEvent, screen } from "@testing-library/react-native";
import { ScrollView } from "react-native";

import { OPUS, engines, modelNames, models, openSheet, renderPicker, trigger, triggerValue } from "./model-picker-test-utils";
import { GLM, GPT, SONNET, catalogOf, codexInstance, engineInstance, matrixInstance } from "./model-test-catalog";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

let mockSheet: { isPresented: boolean; onDismiss: () => void } = { isPresented: false, onDismiss: () => {} };

// As the native sheet does while it slides away, this one keeps its content
// when it is not presented.
jest.mock("@expo/ui", () => {
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    BottomSheet: (props: { children: ReactNode; isPresented: boolean; onDismiss: () => void }) => {
      mockSheet = props;
      return <View testID="expo-bottom-sheet">{props.children}</View>;
    },
    RNHostView: ({ children }: { children: ReactNode }) => children,
  };
});
jest.mock("@/lib/queries/use-matrix-credit-balance", () => ({
  useMatrixCreditBalance: () => ({ label: null }),
}));

beforeEach(() => {
  mockSheet = { isPresented: false, onDismiss: () => {} };
});
afterEach(cleanup);

describe("the model sheet", () => {
  const catalog = () => catalogOf(
    codexInstance(),
    matrixInstance([[SONNET.model, "Sonnet 5"], [OPUS.model, "Opus 5"], [GLM.model, "GLM Flash", "unavailable"]]),
  );

  it("stays shut, with nothing in it, until the trigger is tapped", () => {
    renderPicker(catalog(), SONNET);

    expect(mockSheet.isPresented).toBe(false);
    expect(screen.queryByTestId("model-sheet")).toBeNull();
    expect(screen.queryByText("Choose model")).toBeNull();
  });

  it("opens from the trigger with Matrix AI first and the selection's engine and model marked", () => {
    renderPicker(catalog(), SONNET);

    openSheet();

    expect(mockSheet.isPresented).toBe(true);
    expect(screen.getByRole("header", { name: "Choose model" })).toBeTruthy();
    expect(engines().getAllByRole("button").map((node) => [node.props.accessibilityLabel, node.props.accessibilityState.selected]))
      .toEqual([["Matrix AI", true], ["Codex", false]]);
    expect(modelNames()).toEqual(["Sonnet 5, Matrix AI", "Opus 5, Matrix AI", "GLM Flash, Matrix AI · Model unavailable"]);
    expect(models().getByRole("button", { name: "Sonnet 5, Matrix AI" }).props.accessibilityState).toMatchObject({ selected: true });
    expect(models().getByRole("button", { name: "Opus 5, Matrix AI" }).props.accessibilityState).toMatchObject({ selected: false });
  });

  it("applies the model that is chosen and closes", () => {
    const change = renderPicker(catalog(), SONNET);
    openSheet();

    fireEvent.press(models().getByRole("button", { name: "Opus 5, Matrix AI" }));

    expect(change).toHaveBeenCalledTimes(1);
    expect(change).toHaveBeenCalledWith(OPUS);
    expect(mockSheet.isPresented).toBe(false);
  });

  it("closes without touching the selection, or the options saved with it, when the current model is chosen again", () => {
    const change = renderPicker(catalog(), { ...SONNET, options: [{ id: "effort", value: "high" }] });
    openSheet();

    fireEvent.press(models().getByRole("button", { name: "Sonnet 5, Matrix AI" }));

    expect(change).not.toHaveBeenCalled();
    expect(mockSheet.isPresented).toBe(false);
  });

  it("shows another engine's models when its chip is tapped, applying nothing until a model is chosen", () => {
    const change = renderPicker(catalog(), SONNET);
    openSheet();

    fireEvent.press(engines().getByRole("button", { name: "Codex" }));

    expect(modelNames()).toEqual(["GPT-5.6-Sol, Codex"]);
    expect(change).not.toHaveBeenCalled();
    expect(mockSheet.isPresented).toBe(true);
    expect(triggerValue()).toBe("Matrix AI · Sonnet 5");

    fireEvent.press(models().getByRole("button", { name: "GPT-5.6-Sol, Codex" }));
    expect(change).toHaveBeenCalledWith(GPT);
    expect(mockSheet.isPresented).toBe(false);
  });

  it("closes when the sheet is swiped away, and starts the next opening on the selection's engine", () => {
    renderPicker(catalog(), SONNET);
    openSheet();
    fireEvent.press(engines().getByRole("button", { name: "Codex" }));

    act(() => mockSheet.onDismiss());
    expect(mockSheet.isPresented).toBe(false);

    openSheet();
    expect(engines().getByRole("button", { name: "Matrix AI" }).props.accessibilityState).toMatchObject({ selected: true });
    expect(modelNames()).toContain("Sonnet 5, Matrix AI");
  });

  it("brings the selection's engine into view on every opening, without animating", () => {
    const scrollTo = ScrollView.prototype.scrollTo as unknown as jest.Mock;
    const layout = (x: number, width: number) => ({ nativeEvent: { layout: { x, y: 0, width, height: 44 } } });
    // A row 200pt wide whose second chip, the selection's, ends 60pt past it.
    const measure = () => {
      fireEvent(screen.getByTestId("model-sheet-engines"), "layout", layout(0, 200));
      fireEvent(engines().getByRole("button", { name: "Matrix AI" }), "layout", layout(0, 150));
      fireEvent(engines().getByRole("button", { name: "Codex" }), "layout", layout(158, 102));
    };
    renderPicker(catalog(), GPT);

    for (const opening of [1, 2]) {
      scrollTo.mockClear();
      openSheet();
      measure();
      expect([opening, scrollTo.mock.calls]).toEqual([opening, [[{ x: 60, animated: false }]]]);
      act(() => mockSheet.onDismiss());
    }
  });

  it("shows a model that cannot run, saying why, and does not let it be chosen", () => {
    const change = renderPicker(catalog(), SONNET);
    openSheet();

    const blocked = models().getByRole("button", { name: "GLM Flash, Matrix AI · Model unavailable" });
    expect(blocked.props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(blocked);

    expect(change).not.toHaveBeenCalled();
    expect(mockSheet.isPresented).toBe(true);
  });

  it("shows an engine that cannot run, saying why, with none of its models to choose", () => {
    const change = renderPicker(catalogOf(
      matrixInstance(),
      codexInstance(undefined, { availability: "auth_required" }),
      engineInstance("opencode_default", "opencode", "OpenCode", [], { availability: "setup_required" }),
    ), SONNET);
    openSheet();

    fireEvent.press(engines().getByRole("button", { name: "Codex, Authentication required" }));
    const blocked = models().getByRole("button", { name: "GPT-5.6-Sol, Codex · Authentication required" });
    expect(blocked.props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(blocked);

    fireEvent.press(engines().getByRole("button", { name: "OpenCode, Setup required" }));
    expect(models().queryAllByRole("button")).toEqual([]);
    expect(models().getByText("Setup required")).toBeTruthy();
    expect(change).not.toHaveBeenCalled();
  });

  it("keeps a saved model the catalog no longer lists, checked and out of reach, beside a deliberate replacement", () => {
    const missing = { ...SONNET, model: GLM.model };
    const change = renderPicker(catalogOf(matrixInstance()), missing);

    expect(triggerValue()).toBe(`Matrix AI · ${missing.model} · unavailable`);
    openSheet();
    expect(modelNames()).toEqual([`${missing.model}, Matrix AI · unavailable`, "Sonnet 5, Matrix AI"]);
    const saved = models().getByRole("button", { name: `${missing.model}, Matrix AI · unavailable` });
    expect(saved.props.accessibilityState).toMatchObject({ selected: true, disabled: true });
    fireEvent.press(saved);
    expect(change).not.toHaveBeenCalled();

    fireEvent.press(models().getByRole("button", { name: "Sonnet 5, Matrix AI" }));
    expect(change).toHaveBeenCalledWith(SONNET);
  });

  it("tells equally named models on different routes apart", () => {
    renderPicker(catalogOf(
      matrixInstance(),
      engineInstance("kernel_default", "kernel", "Kernel", [[SONNET.model, "Sonnet 5"]], { connectionLabel: "Matrix AI" }),
    ), SONNET);
    openSheet();

    expect(modelNames()).toEqual(["Sonnet 5, Matrix AI", "Sonnet 5, Matrix AI · Kernel"]);
  });

  it("omits the retired Matrix SDK route", () => {
    renderPicker(catalogOf(
      engineInstance("kernel_matrix_included", "kernel", "Claude SDK", [[SONNET.model, "SDK duplicate"]]),
      matrixInstance(),
    ), SONNET);
    openSheet();

    expect(screen.queryByText(/SDK duplicate/)).toBeNull();
    expect(modelNames()).toEqual(["Sonnet 5, Matrix AI"]);
  });

  it("blocks every choice while the models are being checked, keeping the selected name in view", () => {
    const change = renderPicker(catalog(), SONNET, { catalogLoading: true });

    expect(screen.getByText("Matrix AI · Sonnet 5")).toBeTruthy();
    expect(trigger().props.accessibilityState).toMatchObject({ busy: true, disabled: false });
    openSheet();
    expect(screen.getAllByLabelText("Checking model availability")).toHaveLength(2);
    for (const node of models().getAllByRole("button")) {
      expect(node.props.accessibilityState).toMatchObject({ disabled: true });
      fireEvent.press(node);
    }
    expect(change).not.toHaveBeenCalled();
    expect(mockSheet.isPresented).toBe(true);
  });
});
