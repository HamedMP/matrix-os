import type { ReactNode } from "react";
import { cleanup, fireEvent, screen, within } from "@testing-library/react-native";

import { engines, openSheet, renderPicker } from "./model-picker-test-utils";
import { GPT, REASONING, SONNET, catalogOf, codexInstance, matrixInstance } from "./model-test-catalog";

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

let mockCredit: { label: string | null; isPending: boolean; isError: boolean };
const mockCreditRead = jest.fn();

jest.mock("@/lib/queries/use-matrix-credit-balance", () => ({
  useMatrixCreditBalance: () => {
    mockCreditRead();
    return mockCredit;
  },
}));

beforeEach(() => {
  mockSheet = { isPresented: false, onDismiss: () => {} };
  mockCredit = { label: null, isPending: false, isError: false };
  mockCreditRead.mockClear();
});
afterEach(cleanup);

describe("the selected model's option in the sheet", () => {
  const catalog = () => catalogOf(matrixInstance(undefined, { options: [REASONING] }), codexInstance());

  it("is not offered beside the trigger", () => {
    renderPicker(catalog(), SONNET);

    expect(screen.queryByText("Reasoning")).toBeNull();
    expect(screen.queryByRole("button", { name: "High" })).toBeNull();
  });

  it("has its own section, named by the option, with the engine's default marked", () => {
    renderPicker(catalog(), SONNET);
    openSheet();

    expect(screen.getByRole("header", { name: "Reasoning" })).toBeTruthy();
    expect(within(screen.getByTestId("model-sheet-option-effort")).getAllByRole("button")
      .map((node) => [node.props.accessibilityLabel, node.props.accessibilityState.selected]))
      .toEqual([["Low", false], ["Medium", true], ["High", false]]);
  });

  it("saves the chosen value with the selection, keeping its other options, and leaves the sheet open", () => {
    const saved = { ...SONNET, options: [{ id: "service_tier", value: "fast" }, { id: "effort", value: "low" }] };
    const change = renderPicker(catalog(), saved);
    openSheet();
    expect(screen.getByRole("button", { name: "Low" }).props.accessibilityState).toMatchObject({ selected: true });

    fireEvent.press(screen.getByRole("button", { name: "High" }));

    expect(change).toHaveBeenCalledWith({ ...SONNET, options: [{ id: "service_tier", value: "fast" }, { id: "effort", value: "high" }] });
    expect(mockSheet.isPresented).toBe(true);
  });

  it("changes nothing when the current value is tapped", () => {
    const change = renderPicker(catalog(), SONNET);
    openSheet();

    fireEvent.press(screen.getByRole("button", { name: "Medium" }));

    expect(change).not.toHaveBeenCalled();
  });

  it("is absent when the selected model has no option", () => {
    renderPicker(catalog(), GPT);
    openSheet();

    expect(screen.queryByRole("header", { name: "Reasoning" })).toBeNull();
    expect(screen.queryByTestId("model-sheet-option-effort")).toBeNull();
  });

  it("is absent for a saved model that cannot run", () => {
    renderPicker(catalogOf(matrixInstance(undefined, { options: [REASONING] })), { ...SONNET, model: "anthropic:revoked-model" });
    openSheet();

    expect(screen.queryByRole("header", { name: "Reasoning" })).toBeNull();
  });

  it("cannot be changed while the models are being checked", () => {
    const change = renderPicker(catalog(), SONNET, { catalogLoading: true });
    openSheet();

    fireEvent.press(screen.getByRole("button", { name: "High" }));

    expect(change).not.toHaveBeenCalled();
  });
});

describe("the Matrix AI credit in the sheet", () => {
  const catalog = () => catalogOf(matrixInstance(), codexInstance());

  const loaded = { label: "$18.40", isPending: false, isError: false };

  it("is not read until the sheet is opened", () => {
    mockCredit = loaded;
    renderPicker(catalog(), SONNET);

    expect(mockCreditRead).not.toHaveBeenCalled();
    expect(screen.queryByText(/credit/i)).toBeNull();
  });

  it("shows the balance the hook reports, read-only, while Matrix AI is the engine shown", () => {
    mockCredit = loaded;
    renderPicker(catalog(), SONNET);
    openSheet();

    expect(within(screen.getByTestId("model-sheet-credit")).getByText("$18.40 credit")).toBeTruthy();
    expect(screen.queryByText(/buy|purchase|subscri|pricing|upgrade|checkout/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /buy|purchase|subscri|credit/i })).toBeNull();

    fireEvent.press(engines().getByRole("button", { name: "Codex" }));
    expect(screen.queryByTestId("model-sheet-credit")).toBeNull();
  });

  it("holds the box's place while the balance is being read", () => {
    mockCredit = { label: null, isPending: true, isError: false };
    renderPicker(catalog(), SONNET);
    openSheet();

    const box = screen.getByTestId("model-sheet-credit");
    expect(within(box).getByTestId("model-sheet-credit-loading")).toBeTruthy();
    expect(within(box).queryByText(/credit/i)).toBeNull();
  });

  it("keeps showing a balance it already has while that balance is read again", () => {
    mockCredit = { label: "$18.40", isPending: true, isError: false };
    renderPicker(catalog(), SONNET);
    openSheet();

    expect(screen.getByText("$18.40 credit")).toBeTruthy();
    expect(screen.queryByTestId("model-sheet-credit-loading")).toBeNull();
  });

  it("is left out when the balance could not be read", () => {
    mockCredit = { label: null, isPending: false, isError: true };
    renderPicker(catalog(), SONNET);
    openSheet();

    expect(mockCreditRead).toHaveBeenCalled();
    expect(screen.queryByTestId("model-sheet-credit")).toBeNull();
  });

  it("is left out when the account has no balance", () => {
    renderPicker(catalog(), SONNET);
    openSheet();

    expect(mockCreditRead).toHaveBeenCalled();
    expect(screen.queryByTestId("model-sheet-credit")).toBeNull();
  });

  it("is left out when the selection runs on another engine", () => {
    mockCredit = loaded;
    renderPicker(catalog(), GPT);
    openSheet();

    expect(engines().getByRole("button", { name: "Codex" }).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.queryByTestId("model-sheet-credit")).toBeNull();
  });
});
