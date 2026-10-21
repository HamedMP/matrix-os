import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";

import { Icon } from "../components/ui/Icon";
import { CloseIcon } from "../components/ui/icons";
import { TextField } from "../components/ui/TextField";

import { flat } from "./ui-test-utils";

describe("TextField", () => {
  afterEach(cleanup);

  it("is a 54pt field on the card colour with its border width reserved", () => {
    render(<TextField testID="name" value="" onChangeText={jest.fn()} placeholder="Project name" />);

    expect(flat(screen.getByTestId("name-container"))).toMatchObject({
      height: 54,
      borderRadius: 14,
      backgroundColor: "#FAF9F7",
      paddingHorizontal: 14,
      borderWidth: 1.5,
      borderColor: "transparent",
    });
  });

  it("sets the value in the 17pt regular style with the tertiary placeholder and the success caret", () => {
    render(<TextField testID="name" value="Portfolio" onChangeText={jest.fn()} placeholder="Project name" />);

    const input = screen.getByTestId("name");
    expect(flat(input)).toMatchObject({
      fontFamily: "Geist_400Regular",
      fontSize: 17,
      color: "#242323",
    });
    expect(input.props).toMatchObject({
      value: "Portfolio",
      placeholder: "Project name",
      placeholderTextColor: "#8A8686",
      selectionColor: "#288A5B",
      cursorColor: "#288A5B",
      multiline: false,
    });
  });

  it("draws the border in the text colour while focused, without changing its width", () => {
    render(<TextField testID="name" value="" onChangeText={jest.fn()} />);

    fireEvent(screen.getByTestId("name"), "focus");
    expect(flat(screen.getByTestId("name-container"))).toMatchObject({
      borderWidth: 1.5,
      borderColor: "#242323",
    });

    fireEvent(screen.getByTestId("name"), "blur");
    expect(flat(screen.getByTestId("name-container"))).toMatchObject({
      borderWidth: 1.5,
      borderColor: "transparent",
    });
  });

  it("reports typed text", () => {
    const onChangeText = jest.fn();
    render(<TextField testID="name" value="" onChangeText={onChangeText} />);

    fireEvent.changeText(screen.getByTestId("name"), "Matrix");
    expect(onChangeText).toHaveBeenCalledWith("Matrix");
  });

  it("shows the clear button only when there is a value, and clears with it", () => {
    const onChangeText = jest.fn();
    render(<TextField clearable value="" onChangeText={onChangeText} placeholder="Project name" />);
    expect(screen.queryByLabelText("Clear Project name")).toBeNull();
    cleanup();

    render(<TextField clearable value="Portfolio" onChangeText={onChangeText} placeholder="Project name" />);
    const clear = screen.getByLabelText("Clear Project name");
    expect(clear.props.accessibilityRole).toBe("button");
    expect(screen.UNSAFE_getByType(Icon).props).toMatchObject({ icon: CloseIcon, size: 18 });

    fireEvent.press(clear);
    expect(onChangeText).toHaveBeenCalledWith("");
  });

  it("gives the clear button a 44pt tap area", () => {
    render(<TextField clearable value="Portfolio" onChangeText={jest.fn()} accessibilityLabel="Name" />);

    const clear = screen.getByLabelText("Clear Name");
    const style = flat(clear);
    const slop = clear.props.hitSlop as number;
    expect((style.width as number) + slop * 2).toBeGreaterThanOrEqual(44);
    expect((style.height as number) + slop * 2).toBeGreaterThanOrEqual(44);
  });

  it("has no clear button unless it is asked for, or when it cannot be edited", () => {
    render(<TextField value="Portfolio" onChangeText={jest.fn()} accessibilityLabel="Name" />);
    expect(screen.queryByLabelText("Clear Name")).toBeNull();
    cleanup();

    render(<TextField clearable editable={false} value="Portfolio" onChangeText={jest.fn()} accessibilityLabel="Name" />);
    expect(screen.queryByLabelText("Clear Name")).toBeNull();
  });

  it("forwards the input props it supports", () => {
    const onSubmitEditing = jest.fn();
    render(
      <TextField
        testID="name"
        value="Portfolio"
        onChangeText={jest.fn()}
        placeholder="Project name"
        accessibilityLabel="Name"
        autoFocus
        returnKeyType="done"
        maxLength={80}
        onSubmitEditing={onSubmitEditing}
      />,
    );

    const input = screen.getByTestId("name");
    expect(input.props).toMatchObject({
      accessibilityLabel: "Name",
      autoFocus: true,
      returnKeyType: "done",
      maxLength: 80,
    });
    fireEvent(input, "submitEditing");
    expect(onSubmitEditing).toHaveBeenCalledTimes(1);
    cleanup();

    render(<TextField testID="name" value="Portfolio" onChangeText={jest.fn()} editable={false} />);
    expect(screen.getByTestId("name").props.editable).toBe(false);
  });

  it("hides what is typed when asked to, and shows it otherwise", () => {
    render(<TextField testID="secret" value="1234" onChangeText={jest.fn()} secureTextEntry />);
    expect(screen.getByTestId("secret").props.secureTextEntry).toBe(true);
    cleanup();

    render(<TextField testID="plain" value="1234" onChangeText={jest.fn()} />);
    expect(screen.getByTestId("plain").props.secureTextEntry).toBeFalsy();
  });

  it("names the input after its placeholder when no label is given", () => {
    render(<TextField testID="name" value="" onChangeText={jest.fn()} placeholder="Project name" />);

    expect(screen.getByTestId("name").props.accessibilityLabel).toBe("Project name");
  });
});
