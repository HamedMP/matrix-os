import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";

import { MenuPicker } from "../components/ui/MenuPicker";

const mockHostProps = jest.fn();

jest.mock("@expo/ui", () => {
  const { Text, View } = jest.requireActual("react-native") as typeof import("react-native");
  const Picker = (props: { children?: ReactNode }) => <View {...props}>{props.children}</View>;
  Picker.Item = ({ label }: { label: string }) => <Text>{label}</Text>;
  return {
    Host: (props: { children: ReactNode }) => {
      mockHostProps(props);
      return props.children;
    },
    Picker,
  };
});

const options = [
  { label: "Low", value: "low" },
  { label: "Extra high", value: "xhigh" },
];

// Jest resolves the default file, which is what iOS and web bundle.
describe("MenuPicker default implementation", () => {
  it("keeps the platform menu picker, sized to its content", () => {
    const onValueChange = jest.fn();
    render(
      <MenuPicker options={options} selectedValue="low" onValueChange={onValueChange} enabled={false} testID="effort-picker" />,
    );

    const picker = screen.getByTestId("effort-picker");
    expect(picker.props.appearance).toBe("menu");
    expect(picker.props.selectedValue).toBe("low");
    expect(picker.props.enabled).toBe(false);
    expect(screen.getByText("Low")).toBeTruthy();
    expect(screen.getByText("Extra high")).toBeTruthy();
    expect(mockHostProps).toHaveBeenCalledWith(expect.objectContaining({ matchContents: true }));

    fireEvent(picker, "valueChange", "xhigh");
    expect(onValueChange).toHaveBeenCalledWith("xhigh");
  });
});
