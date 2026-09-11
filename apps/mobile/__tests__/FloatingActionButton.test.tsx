import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import { render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";

import { FloatingActionButton } from "../components/ui/FloatingActionButton";

describe("FloatingActionButton", () => {
  it("uses the shared floating action treatment by default", () => {
    render(
      <FloatingActionButton
        accessibilityLabel="Create"
        icon={Add01Icon}
      />,
    );

    expect(NativeStyleSheet.flatten(screen.getByLabelText("Create").props.style)).toMatchObject({
      position: "absolute",
      right: 20,
      bottom: 24,
      width: 48,
      height: 48,
      borderRadius: 999,
      backgroundColor: "#2B3715",
    });
  });

  it("accepts surface, size, and position overrides", () => {
    render(
      <FloatingActionButton
        accessibilityLabel="Create"
        icon={Add01Icon}
        size={52}
        rightInset={16}
        bottomInset={32}
        backgroundColor="#442118"
      />,
    );

    expect(NativeStyleSheet.flatten(screen.getByLabelText("Create").props.style)).toMatchObject({
      right: 16,
      bottom: 32,
      width: 52,
      height: 52,
      backgroundColor: "#442118",
    });
  });
});
