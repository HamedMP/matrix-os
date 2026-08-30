import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import { render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";

import { IconButton } from "../components/ui/IconButton";

describe("IconButton", () => {
  it("is transparent by default", () => {
    render(<IconButton accessibilityLabel="Add" icon={Add01Icon} />);

    expect(NativeStyleSheet.flatten(screen.getByLabelText("Add").props.style)).toMatchObject({
      backgroundColor: "transparent",
    });
  });

  it("accepts an explicit background color", () => {
    render(
      <IconButton
        accessibilityLabel="Add"
        icon={Add01Icon}
        backgroundColor="#2B3715"
      />,
    );

    expect(NativeStyleSheet.flatten(screen.getByLabelText("Add").props.style)).toMatchObject({
      backgroundColor: "#2B3715",
    });
  });
});
