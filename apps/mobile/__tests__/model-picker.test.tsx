import type { ReactNode } from "react";
import { cleanup, screen } from "@testing-library/react-native";

import { ProviderLogo } from "@/components/ui/ProviderLogo";

import { createCanonicalProviderCatalogFixture } from "../../../tests/contracts/fixtures/canonical-chat";

import { openSheet, renderPicker, trigger, triggerValue } from "./model-picker-test-utils";
import { GLM, SONNET, catalogOf, matrixInstance } from "./model-test-catalog";
import { flat } from "./ui-test-utils";

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

describe("the model trigger in the composer", () => {
  it("shows the engine's logo and name before the model", () => {
    renderPicker(catalogOf(matrixInstance()), SONNET);

    expect(screen.getByText("Matrix AI · Sonnet 5")).toBeTruthy();
    expect(triggerValue()).toBe("Matrix AI · Sonnet 5");
    expect(screen.UNSAFE_getByType(ProviderLogo).props.provider).toBe("matrix");
  });

  it("shows an agent engine under its own logo", () => {
    renderPicker(createCanonicalProviderCatalogFixture(), { instanceId: "codex_fixture", model: "gpt-5.6-sol" });

    expect(triggerValue()).toBe("Codex fixture · GPT-5.6-Sol");
    expect(screen.UNSAFE_getByType(ProviderLogo).props.provider).toBe("codex");
  });

  it("limits the label to the room the composer's toolbar leaves beside its buttons", () => {
    renderPicker(catalogOf(matrixInstance()), SONNET);

    // 750pt test window, less 2 x (12 margin + 14 padding + 44 button + 8 gap) and 2 x (10 padding + 6 gap + 14 icon).
    expect(flat(screen.getByText("Matrix AI · Sonnet 5")).maxWidth).toBe(750 - 156 - 60);
  });

  it("keeps a saved identity visible while the catalog has not arrived, and cannot be opened", () => {
    renderPicker(null, SONNET);

    expect(triggerValue()).toBe(`${SONNET.model} · checking`);
    expect(screen.getByText(/Checking model availability/)).toBeTruthy();
    expect(trigger().props.accessibilityState).toMatchObject({ disabled: true });
    openSheet();
    expect(mockSheet.isPresented).toBe(false);
  });

  it("says the models are being checked before there is anything to choose", () => {
    renderPicker(null, null, { catalogLoading: true });

    expect(triggerValue()).toBe("Checking models…");
    expect(screen.getByLabelText("Checking model availability")).toBeTruthy();
    expect(trigger().props.accessibilityState).toMatchObject({ disabled: true, busy: true });
  });

  it("retains the saved model when every route is unavailable and shows a safe recovery reason", () => {
    const change = renderPicker(catalogOf(matrixInstance(undefined, {
      availability: "unavailable",
      unavailabilityReason: "disabled_in_settings",
    })), SONNET);

    expect(screen.getByText("Matrix AI · Sonnet 5 · unavailable")).toBeTruthy();
    expect(screen.getByText("Disabled in Settings. Choose another model or check Agents & providers.").props.accessibilityRole)
      .toBe("alert");
    // With nothing to choose the sheet stays shut, so the saved model cannot be picked again.
    expect(trigger().props.accessibilityState).toMatchObject({ disabled: true });
    openSheet();
    expect(mockSheet.isPresented).toBe(false);
    expect(change).not.toHaveBeenCalled();
  });
});

describe("the notices under the trigger", () => {
  const held = () => catalogOf(matrixInstance([[SONNET.model, "Sonnet 5", "unavailable"]], {
    availability: "unavailable",
    connectionState: "credit_reserved",
  }));

  it("lists a model whose credit is held as plain text that cannot be pressed", () => {
    const change = renderPicker(held(), SONNET);

    const note = screen.getByText("Sonnet 5 · Matrix AI · Credit reserved");
    expect(note.props.accessibilityState).toEqual({ disabled: true });
    expect(note.props.onPress).toBeUndefined();
    expect(flat(note)).toMatchObject({ fontSize: 12, lineHeight: 17, color: "#635F5F", flexBasis: "100%" });
    expect(screen.getByText("Your credit is reserved while usage is confirmed.")).toBeTruthy();
    expect(triggerValue()).toBe("Matrix AI · Sonnet 5");
    expect(trigger().props.accessibilityState).toMatchObject({ disabled: true });
    expect(change).not.toHaveBeenCalled();
  });

  it("keeps held models visible before any selection without offering a default", () => {
    renderPicker(held(), null);

    expect(triggerValue()).toBe("Choose a model");
    expect(trigger().props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByText("Sonnet 5 · Matrix AI · Credit reserved")).toBeTruthy();
    expect(screen.queryByText(/GLM/)).toBeNull();
  });

  it("does not label a revoked saved model with another model's credit reservation", () => {
    renderPicker(held(), { ...SONNET, model: "anthropic:revoked-model" });

    expect(screen.getByText("Matrix AI · anthropic:revoked-model · unavailable")).toBeTruthy();
    expect(screen.getByText(/Saved model unavailable/)).toBeTruthy();
  });

  it("lists an unavailable peer of the models that can run", () => {
    renderPicker(catalogOf(matrixInstance([[SONNET.model, "Sonnet 5"], [GLM.model, "GLM Flash", "unavailable"]])), SONNET);

    expect(screen.getByText("GLM Flash · Matrix AI · Model unavailable").props.accessibilityState).toEqual({ disabled: true });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
