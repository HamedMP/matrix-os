import type { ReactNode } from "react";
import { cleanup, fireEvent, screen, within } from "@testing-library/react-native";

import { engines, models, openSheet, renderPicker } from "./model-picker-test-utils";
import { GPT, SONNET, catalogOf, codexInstance, matrixInstance, type Instance } from "./model-test-catalog";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

let mockSheet: { isPresented: boolean } = { isPresented: false };

// As the native sheet does while it slides away, this one keeps its content
// when it is not presented.
jest.mock("@expo/ui", () => {
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    BottomSheet: (props: { children: ReactNode; isPresented: boolean }) => {
      mockSheet = props;
      return <View testID="expo-bottom-sheet">{props.children}</View>;
    },
    RNHostView: ({ children }: { children: ReactNode }) => children,
  };
});

jest.mock("@/lib/queries/use-matrix-credit-balance", () => ({
  useMatrixCreditBalance: () => ({ label: null, isPending: false, isError: false }),
}));

function withModes(instance: Instance, permissionModes: string[]): Instance {
  return { ...instance, supports: { ...instance.supports, permissionModes } };
}

// As the computer lists them: Codex runs turns in all four modes, Matrix AI's own route in Supervised only.
const catalog = () => catalogOf(
  withModes(matrixInstance(), ["supervised"]),
  withModes(codexInstance(), ["supervised", "auto_accept_edits", "auto", "full_access"]),
);

const modes = () => within(screen.getByTestId("model-sheet-permission-mode"));
const modeChips = () => modes().getAllByRole("button")
  .map((node) => [node.props.accessibilityLabel, node.props.accessibilityState.selected]);

beforeEach(() => {
  mockSheet = { isPresented: false };
});
afterEach(cleanup);

describe("the permission mode in the model sheet", () => {
  it("has its own section listing the engine's modes in Desktop's order and names, the current one marked", () => {
    renderPicker(catalog(), GPT, { permissionMode: "auto", onPermissionModeChange: jest.fn() });
    openSheet();

    expect(screen.getByRole("header", { name: "Permission mode" })).toBeTruthy();
    expect(modeChips()).toEqual([
      ["Supervised", false], ["Auto Accept Edits", false], ["Auto", true], ["Full Access", false],
    ]);
  });

  it("sends the chosen mode and leaves the sheet open", () => {
    const changeMode = jest.fn();
    const changeModel = renderPicker(catalog(), GPT, { permissionMode: "supervised", onPermissionModeChange: changeMode });
    openSheet();

    fireEvent.press(modes().getByRole("button", { name: "Full Access" }));

    expect(changeMode).toHaveBeenCalledWith("full_access");
    expect(changeModel).not.toHaveBeenCalled();
    expect(mockSheet.isPresented).toBe(true);
  });

  it("changes nothing when the current mode is tapped, or while the models are being checked", () => {
    const changeMode = jest.fn();
    renderPicker(catalog(), GPT, { permissionMode: "supervised", onPermissionModeChange: changeMode, catalogLoading: true });
    openSheet();

    fireEvent.press(modes().getByRole("button", { name: "Supervised" }));
    fireEvent.press(modes().getByRole("button", { name: "Full Access" }));

    expect(changeMode).not.toHaveBeenCalled();
  });

  it("is absent for an engine that runs turns in one mode only", () => {
    renderPicker(catalog(), SONNET, { permissionMode: "supervised", onPermissionModeChange: jest.fn() });
    openSheet();

    expect(screen.queryByRole("header", { name: "Permission mode" })).toBeNull();
    expect(screen.queryByTestId("model-sheet-permission-mode")).toBeNull();
  });

  it("belongs to the selected model, so it shows with its engine only", () => {
    renderPicker(catalog(), GPT, { permissionMode: "supervised", onPermissionModeChange: jest.fn() });
    openSheet();

    fireEvent.press(engines().getByRole("button", { name: "Matrix AI" }));
    expect(screen.queryByTestId("model-sheet-permission-mode")).toBeNull();

    fireEvent.press(engines().getByRole("button", { name: "Codex" }));
    expect(models().getByRole("button", { name: "GPT-5.6-Sol, Codex" })).toBeTruthy();
    expect(screen.getByTestId("model-sheet-permission-mode")).toBeTruthy();
  });

  it("is absent where the mode cannot be chosen", () => {
    renderPicker(catalog(), GPT, { permissionMode: "supervised" });
    openSheet();

    expect(screen.queryByTestId("model-sheet-permission-mode")).toBeNull();
  });
});
