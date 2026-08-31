import { render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";

import { Divider } from "../components/ui/Divider";

describe("Divider", () => {
  it("renders an edge-to-edge border-colored horizontal rule by default", () => {
    render(<Divider testID="divider" />);

    const style = NativeStyleSheet.flatten(screen.getByTestId("divider").props.style);
    expect(style).toMatchObject({
      alignSelf: "stretch",
      borderTopWidth: NativeStyleSheet.hairlineWidth,
      borderTopColor: "#C8C6C6",
    });
    expect(style.marginHorizontal).toBeUndefined();
    expect(style.paddingHorizontal).toBeUndefined();
    expect(style.marginLeft).toBeUndefined();
    expect(style.marginRight).toBeUndefined();
  });

  it("accepts an optional style override", () => {
    render(<Divider testID="divider" style={{ marginHorizontal: 16 }} />);

    expect(NativeStyleSheet.flatten(screen.getByTestId("divider").props.style)).toMatchObject({
      marginHorizontal: 16,
    });
  });
});
