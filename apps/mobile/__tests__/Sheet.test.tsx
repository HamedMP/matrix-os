import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet, Text } from "react-native";

import { Sheet } from "../components/ui/Sheet";

const mockBottomSheetProps = jest.fn();

jest.mock("@expo/ui", () => {
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    BottomSheet: (props: { children: ReactNode; isPresented: boolean }) => {
      mockBottomSheetProps(props);
      return props.isPresented ? <View testID="expo-bottom-sheet">{props.children}</View> : null;
    },
    RNHostView: ({ children }: { children: ReactNode }) => children,
  };
});

describe("Sheet", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders arbitrary content when presented", () => {
    render(
      <Sheet visible onClose={jest.fn()} testID="actions-sheet">
        <Text>New folder</Text>
      </Sheet>,
    );

    expect(screen.getByTestId("expo-bottom-sheet")).toBeTruthy();
    expect(screen.getByText("New folder")).toBeTruthy();
    expect(
      NativeStyleSheet.flatten(screen.getByTestId("actions-sheet-content").props.style).width,
    ).toEqual(expect.any(Number));
  });

  it("opts the iOS sheet out of the translucent material background", () => {
    render(
      <Sheet visible onClose={jest.fn()}>
        <Text>Contents</Text>
      </Sheet>,
    );

    expect(mockBottomSheetProps).toHaveBeenCalledWith(expect.objectContaining({
      modifiers: [{ $type: "presentationBackground", color: "#F4F7ED" }],
    }));
  });

  it("does not require or render a trigger", () => {
    render(
      <Sheet visible={false} onClose={jest.fn()}>
        <Text>Contents</Text>
      </Sheet>,
    );

    expect(screen.queryByTestId("expo-bottom-sheet")).toBeNull();
  });
});
