import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react-native";
import { ActivityIndicator } from "react-native";

import { ProjectNameSheet, type ProjectNameSheetProps } from "../components/projects/ProjectNameSheet";
import { SheetGrabber } from "../components/ui/SheetChrome";

import { flat } from "./ui-test-utils";

let mockSheet: { isPresented: boolean; onDismiss: () => void } = { isPresented: false, onDismiss: () => {} };

// Keeps its content when it is not presented, as the native sheet does while it slides away.
jest.mock("@expo/ui", () => {
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    BottomSheet: (props: { children: ReactNode; isPresented: boolean; onDismiss: () => void }) => {
      mockSheet = props;
      return <View testID="expo-bottom-sheet">{props.children}</View>;
    },
    RNHostView: ({ children }: { children: ReactNode }) => children,
  };
});

function sheet(overrides: Partial<ProjectNameSheetProps> = {}) {
  const props: ProjectNameSheetProps = {
    visible: true,
    title: "New project",
    confirmLabel: "Create",
    saving: false,
    onSubmit: jest.fn(),
    onCancel: jest.fn(),
    ...overrides,
  };
  return { props, element: <ProjectNameSheet {...props} /> };
}

function renderSheet(overrides: Partial<ProjectNameSheetProps> = {}) {
  const { props, element } = sheet(overrides);
  return { props, ...render(element) };
}

const field = () => screen.getByLabelText("Project name");

describe("project name sheet", () => {
  afterEach(cleanup);

  it("is closed until it is asked for", () => {
    renderSheet({ visible: false });

    expect(mockSheet.isPresented).toBe(false);
  });

  it("pads the sheet 16pt all round, with 16pt between the header and the field, and has no grabber", () => {
    renderSheet();

    expect(mockSheet.isPresented).toBe(true);
    expect(flat(screen.getByTestId("project-name-form"))).toMatchObject({ padding: 16, gap: 16 });
    expect(screen.UNSAFE_queryByType(SheetGrabber)).toBeNull();
  });

  it("heads the sheet with Cancel, the title and the action", () => {
    renderSheet();

    const form = screen.getByTestId("project-name-form");
    const labels = within(form).getAllByText(/./).map((node) => node.props.children);
    expect(labels).toEqual(["Cancel", "New project", "Create"]);
    expect(flat(within(form).getByRole("header", { name: "New project" }))).toMatchObject({
      fontFamily: "Geist_600SemiBold",
      fontSize: 17,
      lineHeight: 25,
    });
    expect(flat(screen.getByRole("button", { name: "Create" }))).toMatchObject({ height: 44, backgroundColor: "#171717" });
  });

  it("opens on an empty, focused field named Project name, limited to the length the server takes", () => {
    renderSheet();

    expect(field().props).toMatchObject({
      value: "",
      placeholder: "Project name",
      autoFocus: true,
      maxLength: 128,
      returnKeyType: "done",
    });
    expect(flat(screen.getByTestId("project-name-input-container")).height).toBe(54);
  });

  it("clears the field from its clear button once there is something in it", () => {
    renderSheet();
    expect(screen.queryByRole("button", { name: "Clear Project name" })).toBeNull();

    fireEvent.changeText(field(), "Portfolio");
    fireEvent.press(screen.getByRole("button", { name: "Clear Project name" }));

    expect(field().props.value).toBe("");
  });

  it.each(["", "   "])("cannot be confirmed while the name is blank (%p)", (name) => {
    const { props } = renderSheet();

    fireEvent.changeText(field(), name);
    const create = screen.getByRole("button", { name: "Create" });
    expect(create.props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(create);
    fireEvent(field(), "submitEditing");

    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("submits the name without the space around it, from the action or from the keyboard", () => {
    const { props } = renderSheet();

    fireEvent.changeText(field(), "  Field notes ");
    expect(screen.getByRole("button", { name: "Create" }).props.accessibilityState).toMatchObject({ disabled: false });
    fireEvent.press(screen.getByRole("button", { name: "Create" }));
    fireEvent(field(), "submitEditing");

    expect(props.onSubmit).toHaveBeenCalledTimes(2);
    expect(props.onSubmit).toHaveBeenNthCalledWith(1, "Field notes");
    expect(props.onSubmit).toHaveBeenNthCalledWith(2, "Field notes");
  });

  it("shows the request in flight on the action and holds the field and a second submit", () => {
    const { props, rerender } = renderSheet();
    fireEvent.changeText(field(), "Field notes");

    rerender(sheet({ ...props, saving: true }).element);

    const create = screen.getByRole("button", { name: "Create" });
    expect(create.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
    expect(within(create).UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
    expect(field().props.editable).toBe(false);
    fireEvent.press(create);
    fireEvent(field(), "submitEditing");

    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the typed name and says what went wrong in one caption line in the danger colour, under the field", () => {
    const { props, rerender } = renderSheet();
    fireEvent.changeText(field(), "Portfolio");

    rerender(sheet({ ...props, failure: "A project with that name already exists." }).element);

    const line = screen.getByRole("alert");
    expect(line.props.children).toBe("A project with that name already exists.");
    expect(flat(line)).toMatchObject({ fontFamily: "Geist_400Regular", fontSize: 13, lineHeight: 18, color: "#BA5236" });
    const block = screen.getByTestId("project-name-field");
    expect(flat(block).gap).toBe(8);
    expect(within(block).getByLabelText("Project name")).toBeTruthy();
    expect(within(block).getByRole("alert")).toBeTruthy();
    expect(field().props.value).toBe("Portfolio");
    expect(mockSheet.isPresented).toBe(true);
  });

  it("shows no failure line otherwise", () => {
    renderSheet();

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("closes from Cancel and when it is dragged away", () => {
    const { props } = renderSheet();

    fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
    act(() => mockSheet.onDismiss());

    expect(props.onCancel).toHaveBeenCalledTimes(2);
  });

  it("starts from an empty field again each time it is opened", () => {
    const { props, rerender } = renderSheet();
    fireEvent.changeText(field(), "Typed and abandoned");

    rerender(sheet({ ...props, visible: false }).element);
    expect(field().props.value).toBe("Typed and abandoned");
    rerender(sheet({ ...props, visible: true }).element);

    expect(field().props.value).toBe("");
  });

  describe("opened with a name, to rename", () => {
    const rename = { title: "Rename project", confirmLabel: "Save", initialName: "Portfolio" };

    it("fills the field with the current name under its own title and action", () => {
      renderSheet(rename);

      expect(screen.getByRole("header", { name: "Rename project" })).toBeTruthy();
      expect(field().props.value).toBe("Portfolio");
      expect(field().props.autoFocus).toBe(true);
    });

    it.each(["Portfolio", "  Portfolio ", "", "  "])("cannot be saved while the name is unchanged or blank (%p)", (name) => {
      const { props } = renderSheet(rename);

      fireEvent.changeText(field(), name);
      const save = screen.getByRole("button", { name: "Save" });
      expect(save.props.accessibilityState).toMatchObject({ disabled: true });
      fireEvent.press(save);
      fireEvent(field(), "submitEditing");

      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it("saves a changed name, including one that differs only in its capitals", () => {
      const { props } = renderSheet(rename);

      fireEvent.changeText(field(), "portfolio");
      fireEvent.press(screen.getByRole("button", { name: "Save" }));

      expect(props.onSubmit).toHaveBeenCalledWith("portfolio");
    });

    it("starts from the current name again each time it is opened", () => {
      const { props, rerender } = renderSheet(rename);
      fireEvent.changeText(field(), "Typed and abandoned");

      rerender(sheet({ ...props, visible: false }).element);
      rerender(sheet({ ...props, visible: true, initialName: "Case studies" }).element);

      expect(field().props.value).toBe("Case studies");
    });
  });
});
