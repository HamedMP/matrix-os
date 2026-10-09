import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react-native";

import {
  NewProjectFrame,
  ProjectFrame,
  ProjectMenuFrame,
  ProjectsListFrame,
  RenameProjectFrame,
} from "../dev/design-preview/projects";

let mockSheet: { isPresented: boolean } = { isPresented: false };

jest.mock("@expo/ui", () => {
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    BottomSheet: (props: { children: ReactNode; isPresented: boolean }) => {
      mockSheet = props;
      return props.isPresented ? <View testID="expo-bottom-sheet">{props.children}</View> : null;
    },
    RNHostView: ({ children }: { children: ReactNode }) => children,
  };
});

type Row = ReturnType<typeof screen.getByTestId>;

// A row's parts carry its test ID as a prefix; the row itself is the button.
function rows(prefix: "project-row-" | "project-chat-"): Row[] {
  return screen.getAllByTestId(new RegExp(`^${prefix}`)).filter((node) => node.props.accessibilityRole === "button");
}

function textsOf(node: Row): string[] {
  return within(node).getAllByText(/./).map((text) => text.props.children);
}

function expectTabBarOnChats() {
  expect(screen.getByRole("tab", { name: "Chats" }).props.accessibilityState).toMatchObject({ selected: true });
  expect(screen.getByRole("tab", { name: "Agents, 2 waiting" })).toBeTruthy();
  expect(screen.getAllByRole("tab")).toHaveLength(5);
}

describe("projects design frames", () => {
  beforeEach(() => {
    mockSheet = { isPresented: false };
  });

  afterEach(cleanup);

  it("P1 lists the frame's three projects with when each last changed, and no chat counts", () => {
    render(<ProjectsListFrame />);

    expect(screen.getByRole("header", { name: "Projects" })).toBeTruthy();
    expect(rows("project-row-").map(textsOf)).toEqual([
      ["Portfolio", "Updated today"],
      ["Matrix", "Updated yesterday"],
      ["Admin", "Updated Sep 30"],
    ]);
    expect(screen.queryByText(/\d+ chats/)).toBeNull();
    expect(mockSheet.isPresented).toBe(false);
  });

  it("P1 sits above the app's tab bar, on Chats, with two agents waiting", () => {
    render(<ProjectsListFrame />);

    expectTabBarOnChats();
  });

  it("P1 filters as its search field is typed in, and opens the new project sheet from New project", () => {
    render(<ProjectsListFrame />);

    fireEvent.changeText(screen.getByLabelText("Search projects"), "adm");
    expect(rows("project-row-").map(textsOf)).toEqual([["Admin", "Updated Sep 30"]]);

    fireEvent.press(screen.getByRole("button", { name: "New project" }));
    expect(mockSheet.isPresented).toBe(true);
  });

  it("P1b opens the new project sheet over the list, on an empty name that cannot be created yet", () => {
    render(<NewProjectFrame />);

    expect(mockSheet.isPresented).toBe(true);
    const sheet = screen.getByTestId("expo-bottom-sheet");
    expect(textsOf(sheet)).toEqual(["Cancel", "New project", "Create"]);
    expect(within(sheet).getByLabelText("Project name").props).toMatchObject({ value: "", placeholder: "Project name" });
    expect(within(sheet).getByRole("button", { name: "Create" }).props.accessibilityState).toMatchObject({ disabled: true });
    expect(rows("project-row-")).toHaveLength(3);

    fireEvent.press(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(mockSheet.isPresented).toBe(false);
  });

  it("P2 shows Portfolio with the frame's four chats, without the chat count", () => {
    render(<ProjectFrame />);

    expect(within(screen.getByTestId("project-top-bar")).getByRole("header", { name: "Portfolio" })).toBeTruthy();
    expect(textsOf(screen.getByTestId("project-header"))).toEqual(["Portfolio", "Updated today"]);
    expect(screen.getByRole("header", { name: "Chats" })).toBeTruthy();
    expect(rows("project-chat-").map(textsOf)).toEqual([
      ["Case study", "Draft ready to review", "2h"],
      ["Landing page copy", "Three headline options", "Yesterday"],
      ["Pricing page", "Compared 4 competitors", "Mon"],
      ["Portfolio site build", "Preview is live", "Sep 28"],
    ]);
    expect(screen.queryByText(/\d+ chats/)).toBeNull();
    expect(mockSheet.isPresented).toBe(false);
  });

  it("P2 ends with the composer for a new chat in Portfolio, on Matrix AI · Sonnet 5, above the tab bar", () => {
    render(<ProjectFrame />);

    expect(screen.getByLabelText("Message Matrix").props.placeholder).toBe("New chat in Portfolio");
    expect(within(screen.getByTestId("composer-toolbar-leading")).getByText("Matrix AI · Sonnet 5")).toBeTruthy();
    expectTabBarOnChats();
  });

  it("P2 opens the menu from its options button", () => {
    render(<ProjectFrame />);

    fireEvent.press(screen.getByRole("button", { name: "Project options" }));

    expect(mockSheet.isPresented).toBe(true);
    expect(screen.getByTestId("project-menu")).toBeTruthy();
  });

  it("P3 opens the menu over the project: Rename and Archive project, without what is left out", () => {
    render(<ProjectMenuFrame />);

    expect(mockSheet.isPresented).toBe(true);
    const sheet = screen.getByTestId("expo-bottom-sheet");
    expect(textsOf(sheet)).toEqual(["Portfolio", "Updated today", "Rename", "Archive project"]);
    for (const text of ["12 chats", "Project instructions", "Share project", "Delete project"]) {
      expect(screen.queryByText(text)).toBeNull();
    }
    expect(rows("project-chat-")).toHaveLength(4);
  });

  it("P3 gives way to the rename form when Rename is pressed", () => {
    render(<ProjectMenuFrame />);

    fireEvent.press(screen.getByRole("button", { name: "Rename" }));

    expect(mockSheet.isPresented).toBe(true);
    expect(screen.getByRole("header", { name: "Rename project" })).toBeTruthy();
  });

  it("P4 opens the rename sheet over the project, filled with its name", () => {
    render(<RenameProjectFrame />);

    expect(mockSheet.isPresented).toBe(true);
    const sheet = screen.getByTestId("expo-bottom-sheet");
    expect(textsOf(sheet)).toEqual(["Cancel", "Rename project", "Save"]);
    expect(within(sheet).getByLabelText("Project name").props.value).toBe("Portfolio");
    expect(rows("project-chat-")).toHaveLength(4);

    fireEvent.press(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(mockSheet.isPresented).toBe(false);
  });
});
