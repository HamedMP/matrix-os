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

  it("replaces its icon with a spinner while loading", () => {
    render(
      <IconButton
        accessibilityLabel="Add"
        icon={Add01Icon}
        iconTestID="add-icon"
        loading
        loadingTestID="add-loading"
      />,
    );

    expect(screen.getByTestId("add-loading")).toBeTruthy();
    expect(screen.queryByTestId("add-icon")).toBeNull();
    expect(screen.getByLabelText("Add").props.accessibilityState).toMatchObject({
      busy: true,
      disabled: true,
    });
  });

});
