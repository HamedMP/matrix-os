import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react-native";

import { DesignPreview } from "../dev/design-preview/DesignPreview";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

const mockSetParams = jest.fn();
let mockSheet: { isPresented: boolean; onDismiss: () => void } = { isPresented: false, onDismiss: () => {} };

jest.mock("expo-router", () => ({ useRouter: () => ({ setParams: mockSetParams }) }));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 62, right: 0, bottom: 34, left: 0 }),
}));
jest.mock("@/lib/use-keyboard-visible", () => ({ useKeyboardVisible: () => false }));
jest.mock("@expo/ui", () => {
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    BottomSheet: (props: { children: ReactNode; isPresented: boolean; onDismiss: () => void }) => {
      mockSheet = props;
      return props.isPresented ? <View testID="expo-bottom-sheet">{props.children}</View> : null;
    },
    RNHostView: ({ children }: { children: ReactNode }) => children,
  };
});

const labels = (testID: string) => within(screen.getByTestId(testID)).getAllByRole("button")
  .map((node) => node.props.accessibilityLabel);

describe("frame C3 in the design preview", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    act(() => jest.runOnlyPendingTimers());
    cleanup();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it("is listed with the other frames", () => {
    render(<DesignPreview frame={undefined} />);

    fireEvent.press(screen.getByRole("button", { name: "C3" }));
    expect(mockSetParams).toHaveBeenCalledWith({ frame: "C3" });
  });

  it("draws the model sheet open over the new chat", () => {
    render(<DesignPreview frame="C3" />);

    expect(screen.getByRole("header", { name: "New chat" })).toBeTruthy();
    expect(screen.getByRole("header", { name: "What should we work on?" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Chats" })).toBeTruthy();
    expect(mockSheet.isPresented).toBe(true);
    expect(screen.getByRole("header", { name: "Choose model" })).toBeTruthy();
  });

  it("holds the frame's engines, with Matrix AI selected, and its three models, the first checked", () => {
    render(<DesignPreview frame="C3" />);

    expect(labels("model-sheet-engines")).toEqual(["Matrix AI", "Claude Code", "Codex", "Hermes"]);
    expect(within(screen.getByTestId("model-sheet-engines")).getByRole("button", { name: "Matrix AI" }).props.accessibilityState)
      .toMatchObject({ selected: true });
    expect(labels("model-sheet-models")).toEqual(["Claude Sonnet 5, Matrix AI", "GLM, Matrix AI", "GF1, Matrix AI"]);
    expect(within(screen.getByTestId("model-sheet-models")).getAllByRole("button").map((node) => node.props.accessibilityState.selected))
      .toEqual([true, false, false]);
    expect(screen.getByText("$18.40 credit")).toBeTruthy();
  });

  it("leaves out the frame's model categories, its Buy credit button and its subscription line", () => {
    render(<DesignPreview frame="C3" />);

    expect(screen.queryByText(/Coding|General/)).toBeNull();
    expect(screen.queryByText(/buy|subscription/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /buy/i })).toBeNull();
  });

  it("closes when a model is chosen and opens again from the trigger", () => {
    render(<DesignPreview frame="C3" />);

    fireEvent.press(screen.getByRole("button", { name: "GLM, Matrix AI" }));
    expect(mockSheet.isPresented).toBe(false);

    fireEvent.press(screen.getByRole("button", { name: "Model" }));
    expect(mockSheet.isPresented).toBe(true);
  });
});
