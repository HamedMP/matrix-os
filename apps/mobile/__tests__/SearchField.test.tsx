import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";

import { SearchField } from "../components/shell/Controls";
import { Icon } from "../components/ui/Icon";
import { SearchIcon } from "../components/ui/icons";

import { flat } from "./ui-test-utils";

describe("SearchField", () => {
  afterEach(cleanup);

  it("is a 45pt borderless field on the card colour", () => {
    render(<SearchField placeholder="Search projects" />);

    const style = flat(screen.root);
    expect(style).toMatchObject({
      height: 45,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderRadius: 14,
      paddingHorizontal: 14,
      backgroundColor: "#FAF9F7",
    });
    expect(style.borderWidth).toBeUndefined();
    expect(style.borderColor).toBeUndefined();
  });

  it("leads with a 16pt search icon in the secondary text colour", () => {
    render(<SearchField placeholder="Search projects" />);

    expect(screen.UNSAFE_getAllByType(Icon)[0]?.props).toMatchObject({
      icon: SearchIcon,
      size: 16,
      color: "#635F5F",
    });
  });

  it("sets the input in the 15pt regular style with the tertiary placeholder", () => {
    render(<SearchField placeholder="Search projects" />);

    const input = screen.getByLabelText("Search projects");
    expect(flat(input)).toMatchObject({
      flex: 1,
      fontFamily: "Geist_400Regular",
      fontSize: 15,
      color: "#242323",
    });
    expect(input.props).toMatchObject({
      placeholder: "Search projects",
      placeholderTextColor: "#8A8686",
    });
  });

  it("keeps its own text and clears it from the clear button", () => {
    const onChangeText = jest.fn();
    render(<SearchField placeholder="Search projects" onChangeText={onChangeText} />);
    expect(screen.queryByLabelText("Clear Search projects")).toBeNull();

    fireEvent.changeText(screen.getByLabelText("Search projects"), "port");
    expect(onChangeText).toHaveBeenLastCalledWith("port");
    expect(screen.getByLabelText("Search projects").props.value).toBe("port");

    fireEvent.press(screen.getByLabelText("Clear Search projects"));
    expect(onChangeText).toHaveBeenLastCalledWith("");
    expect(screen.getByLabelText("Search projects").props.value).toBe("");
    expect(screen.queryByLabelText("Clear Search projects")).toBeNull();
  });

  it("shows a controlled value and reports the clear without changing it itself", () => {
    const onChangeText = jest.fn();
    render(<SearchField placeholder="Search" value="matrix" onChangeText={onChangeText} />);

    fireEvent.press(screen.getByLabelText("Clear Search"));
    expect(onChangeText).toHaveBeenCalledWith("");
    expect(screen.getByLabelText("Search").props.value).toBe("matrix");
  });

  it("gives the clear button a 44pt tap area", () => {
    render(<SearchField placeholder="Search" value="matrix" />);

    const clear = screen.getByLabelText("Clear Search");
    const slop = clear.props.hitSlop as number;
    expect((flat(clear).width as number) + slop * 2).toBeGreaterThanOrEqual(44);
    expect((flat(clear).height as number) + slop * 2).toBeGreaterThanOrEqual(44);
  });
});
