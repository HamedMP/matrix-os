import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";

import { SheetActionHeader, SheetGrabber } from "../components/ui/SheetChrome";

import { flat } from "./ui-test-utils";

describe("SheetGrabber", () => {
  afterEach(cleanup);

  it("is a centred 36 by 5 pill in the grabber colour, 10pt from the top", () => {
    render(<SheetGrabber testID="grabber" />);

    const grabber = screen.getByTestId("grabber");
    expect(flat(grabber)).toMatchObject({
      width: 36,
      height: 5,
      borderRadius: 9999,
      backgroundColor: "#D6D3CF",
      marginTop: 10,
      alignSelf: "center",
    });
    expect(grabber.props.accessibilityElementsHidden).toBe(true);
    expect(grabber.props.importantForAccessibility).toBe("no-hide-descendants");
  });
});

describe("SheetActionHeader", () => {
  afterEach(cleanup);

  function renderHeader(overrides: Partial<Parameters<typeof SheetActionHeader>[0]> = {}) {
    const onCancel = jest.fn();
    const onConfirm = jest.fn();
    render(
      <SheetActionHeader
        testID="header"
        title="Rename project"
        cancelLabel="Cancel"
        onCancel={onCancel}
        confirmLabel="Save"
        onConfirm={onConfirm}
        {...overrides}
      />,
    );
    return { onCancel, onConfirm };
  }

  it("is a 44pt row with a 17pt semibold title centred between its two buttons", () => {
    renderHeader();

    expect(flat(screen.getByTestId("header"))).toMatchObject({
      height: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    });
    const title = screen.getByRole("header", { name: "Rename project" });
    expect(flat(title)).toMatchObject({
      fontFamily: "Geist_600SemiBold",
      fontSize: 17,
      lineHeight: 25,
      color: "#242323",
    });
    expect(title.props.numberOfLines).toBe(1);
    expect(flat(title).flexShrink).toBe(1);
  });

  it("has a text-only button at the left and a filled button at the right", () => {
    const { onCancel, onConfirm } = renderHeader();

    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Save" });
    expect(flat(cancel).backgroundColor).toBeUndefined();
    expect(flat(screen.getByText("Cancel")).color).toBe("#0A0A0A");
    expect(flat(confirm).backgroundColor).toBe("#171717");
    expect(flat(screen.getByText("Save")).color).toBe("#FAFAFA");

    fireEvent.press(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.press(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("disables the confirm button", () => {
    const { onConfirm } = renderHeader({ confirmDisabled: true });

    const confirm = screen.getByRole("button", { name: "Save" });
    fireEvent.press(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(confirm.props.accessibilityState).toMatchObject({ disabled: true });
    expect(flat(confirm).opacity).toBe(0.5);
  });

  it("marks the confirm button busy while it is loading", () => {
    const { onConfirm } = renderHeader({ confirmLoading: true });

    const confirm = screen.getByRole("button", { name: "Save" });
    fireEvent.press(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(confirm.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
  });
});
