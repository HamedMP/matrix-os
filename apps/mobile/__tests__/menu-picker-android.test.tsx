import type { ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";

// The Android implementation is imported by its platform file name: Jest
// resolves `MenuPicker` to the default (iOS/web) file.
import { MenuPicker } from "../components/ui/MenuPicker.android";

const mockDropdownMenuProps = jest.fn();

jest.mock("@expo/ui", () => ({
  Host: ({ children }: { children: ReactNode }) => children,
}));

jest.mock("@expo/ui/jetpack-compose", () => {
  const { Pressable, Text, View } = jest.requireActual("react-native") as typeof import("react-native");
  function DropdownMenu(props: { expanded?: boolean; children: ReactNode }) {
    mockDropdownMenuProps(props);
    return <View testID="dropdown-menu">{props.children}</View>;
  }
  DropdownMenu.Trigger = ({ children }: { children: ReactNode }) => children;
  DropdownMenu.Items = function Items({ children }: { children: ReactNode }) {
    return <View testID="dropdown-items">{children}</View>;
  };
  function DropdownMenuItem({ onClick, children }: { onClick?: () => void; children: ReactNode }) {
    return <Pressable accessibilityRole="menuitem" onPress={onClick}>{children}</Pressable>;
  }
  DropdownMenuItem.Text = ({ children }: { children: ReactNode }) => children;
  DropdownMenuItem.TrailingIcon = function TrailingIcon({ children }: { children: ReactNode }) {
    return <View testID="selected-mark">{children}</View>;
  };
  return {
    DropdownMenu,
    DropdownMenuItem,
    RNHostView: ({ children }: { children: ReactNode }) => children,
    Text: ({ children }: { children: ReactNode }) => <Text>{children}</Text>,
  };
});

const options = [
  { label: "Low", value: "low" },
  { label: "Extra high", value: "xhigh" },
];

function lastMenuProps(): { expanded?: boolean; onDismissRequest?: () => void } {
  return mockDropdownMenuProps.mock.calls.at(-1)?.[0];
}

describe("MenuPicker on Android", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows the selected option in a compact trigger instead of a full-width text field", () => {
    render(
      <MenuPicker
        options={options}
        selectedValue="xhigh"
        onValueChange={jest.fn()}
        accessibilityLabel="Reasoning effort"
        maxLabelWidth={120}
        testID="effort-picker"
      />,
    );

    const trigger = screen.getByTestId("effort-picker");
    expect(trigger.props.accessibilityRole).toBe("button");
    expect(trigger.props.accessibilityLabel).toBe("Reasoning effort");
    expect(trigger.props.accessibilityValue).toEqual({ text: "Extra high" });

    // A long label is cut off rather than widening the composer row.
    const label = screen.getByTestId("effort-picker-label");
    expect(label.props.numberOfLines).toBe(1);
    expect(NativeStyleSheet.flatten(label.props.style).maxWidth).toBe(120);
    expect(label.props.children).toBe("Extra high");
    expect(lastMenuProps().expanded).toBe(false);
  });

  it("opens the native menu on press and reports the chosen value", () => {
    const onValueChange = jest.fn();
    render(
      <MenuPicker options={options} selectedValue="low" onValueChange={onValueChange} testID="effort-picker" />,
    );

    fireEvent.press(screen.getByTestId("effort-picker"));
    expect(lastMenuProps().expanded).toBe(true);

    fireEvent.press(screen.getAllByRole("menuitem")[1]!);
    expect(onValueChange).toHaveBeenCalledWith("xhigh");
    expect(lastMenuProps().expanded).toBe(false);
  });

  it("closes without a change when the menu is dismissed", () => {
    const onValueChange = jest.fn();
    render(
      <MenuPicker options={options} selectedValue="low" onValueChange={onValueChange} testID="effort-picker" />,
    );

    fireEvent.press(screen.getByTestId("effort-picker"));
    expect(lastMenuProps().expanded).toBe(true);
    act(() => {
      lastMenuProps().onDismissRequest?.();
    });

    expect(lastMenuProps().expanded).toBe(false);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("marks only the selected option in the menu", () => {
    render(
      <MenuPicker options={options} selectedValue="low" onValueChange={jest.fn()} testID="effort-picker" />,
    );

    expect(screen.getAllByTestId("selected-mark")).toHaveLength(1);
  });

  it("does not open while disabled", () => {
    render(
      <MenuPicker
        options={options}
        selectedValue="low"
        onValueChange={jest.fn()}
        enabled={false}
        testID="effort-picker"
      />,
    );

    const trigger = screen.getByTestId("effort-picker");
    expect(trigger.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    fireEvent.press(trigger);
    expect(lastMenuProps().expanded).toBe(false);
  });

  it("shows the placeholder when the selected value has no option", () => {
    const { rerender } = render(
      <MenuPicker options={options} selectedValue="missing" onValueChange={jest.fn()} testID="effort-picker" />,
    );
    expect(screen.getByTestId("effort-picker-label").props.children).toBe("");

    rerender(
      <MenuPicker
        options={options}
        selectedValue="missing"
        onValueChange={jest.fn()}
        placeholder="Choose a model"
        testID="effort-picker"
      />,
    );
    expect(screen.getByTestId("effort-picker-label").props.children).toBe("Choose a model");
    expect(screen.queryAllByTestId("selected-mark")).toHaveLength(0);
  });
});
