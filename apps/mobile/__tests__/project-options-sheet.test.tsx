import type { ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { ProjectOptionsSheet, type ProjectOptionsSheetProps } from "../components/projects/ProjectOptionsSheet";
import { IconTile } from "../components/ui/IconTile";
import { ArchiveIcon, EditIcon, FolderIcon } from "../components/ui/icons";

import { flat, pressedStyle } from "./ui-test-utils";

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

function sheet(overrides: Partial<ProjectOptionsSheetProps> = {}) {
  const props: ProjectOptionsSheetProps = {
    page: "menu",
    name: "Portfolio",
    updated: "Updated today",
    archiving: false,
    renaming: false,
    onRename: jest.fn(),
    onArchive: jest.fn(),
    onSubmitName: jest.fn(),
    onClose: jest.fn(),
    ...overrides,
  };
  const element = (
    <SafeAreaInsetsContext.Provider value={{ top: 62, right: 0, bottom: 34, left: 0 }}>
      <ProjectOptionsSheet {...props} />
    </SafeAreaInsetsContext.Provider>
  );
  return { props, element };
}

function renderSheet(overrides: Partial<ProjectOptionsSheetProps> = {}) {
  const { props, element } = sheet(overrides);
  return { props, ...render(element) };
}

const row = (name: string) => screen.getByRole("button", { name });

describe("project options sheet", () => {
  afterEach(cleanup);

  it("is closed until the menu is asked for", () => {
    renderSheet({ page: null });

    expect(mockSheet.isPresented).toBe(false);
    expect(screen.queryByTestId("project-menu")).toBeNull();
  });

  describe("menu", () => {
    it("pads the sheet 20pt at the sides and 10pt past the home indicator, with 14pt between blocks", () => {
      renderSheet();

      expect(mockSheet.isPresented).toBe(true);
      const menu = flat(screen.getByTestId("project-menu"));
      expect(menu).toMatchObject({ paddingHorizontal: 20, paddingBottom: 34 + 10, gap: 14 });
      expect(menu.paddingTop).toBeUndefined();
    });

    it("starts with the grabber, which brings the 10pt above it", () => {
      renderSheet();

      const first = screen.getByTestId("project-menu").children[0];
      expect(typeof first === "string" ? first : first.props.testID).toBe("project-menu-grabber");
      expect(flat(screen.getByTestId("project-menu-grabber"))).toMatchObject({ width: 36, height: 5, marginTop: 10 });
    });

    it("heads the menu with a 40pt rounded folder tile and the project's name over when it last changed", () => {
      renderSheet();

      const head = screen.getByTestId("project-menu-head");
      expect(flat(head)).toMatchObject({ flexDirection: "row", alignItems: "center", gap: 12 });
      expect(within(head).UNSAFE_getByType(IconTile).props).toMatchObject({ icon: FolderIcon, size: 40 });
      expect(flat(screen.getByTestId("project-menu-tile"))).toMatchObject({ width: 40, height: 40, borderRadius: 12 });
      expect(flat(within(head).getByRole("header", { name: "Portfolio" }))).toMatchObject({
        fontFamily: "Geist_600SemiBold",
        fontSize: 17,
        lineHeight: 25,
        color: "#242323",
      });
      expect(flat(within(head).getByText("Updated today"))).toMatchObject({
        fontFamily: "Geist_400Regular",
        fontSize: 13,
        lineHeight: 18,
        color: "#635F5F",
      });
    });

    it("leaves the second line of the head out when the time is not known", () => {
      renderSheet({ updated: undefined });

      const texts = within(screen.getByTestId("project-menu-head")).getAllByText(/./);
      expect(texts.map((node) => node.props.children)).toEqual(["Portfolio"]);
    });

    it("groups Rename and, apart from it, Archive project, each on the card colour with the field radius", () => {
      renderSheet();

      for (const id of ["project-menu-actions", "project-menu-archive"]) {
        expect(flat(screen.getByTestId(id))).toMatchObject({ backgroundColor: "#FAF9F7", borderRadius: 14 });
      }
      expect(within(screen.getByTestId("project-menu-actions")).getByRole("button", { name: "Rename" })).toBeTruthy();
      expect(within(screen.getByTestId("project-menu-archive")).getByRole("button", { name: "Archive project" })).toBeTruthy();
      expect(screen.getAllByRole("button")).toHaveLength(2);
    });

    it.each([
      ["Rename", EditIcon],
      ["Archive project", ArchiveIcon],
    ])("draws %s as a row padded 16 by 14 with a 20pt icon 12pt from its label, in the text colour", (label, icon) => {
      renderSheet();

      const button = row(label);
      expect(flat(button)).toMatchObject({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 14,
      });
      expect(within(button).UNSAFE_getByType(HugeiconsIcon).props).toMatchObject({ icon, size: 20, color: "#242323" });
      expect(flat(within(button).getByText(label))).toMatchObject({
        fontFamily: "Geist_400Regular",
        fontSize: 16,
        lineHeight: 22,
        color: "#242323",
      });
    });

    it("gives each row a target of at least 44pt and dims it while it is pressed", () => {
      renderSheet();

      for (const label of ["Rename", "Archive project"]) {
        expect(flat(row(label)).minHeight).toBe(44);
      }
      expect(pressedStyle({ accessibilityLabel: "Rename" }).opacity).toBe(0.65);
    });

    it("asks for the rename form from Rename and for the archive from Archive project", () => {
      const { props } = renderSheet();

      fireEvent.press(row("Rename"));
      expect(props.onRename).toHaveBeenCalledTimes(1);
      expect(props.onArchive).not.toHaveBeenCalled();

      fireEvent.press(row("Archive project"));
      expect(props.onArchive).toHaveBeenCalledTimes(1);
    });

    it("holds both rows while the archive request is in flight", () => {
      const { props } = renderSheet({ archiving: true });

      for (const label of ["Rename", "Archive project"]) {
        expect(row(label).props.accessibilityState).toMatchObject({ disabled: true });
        expect(flat(row(label)).opacity).toBe(0.5);
        fireEvent.press(row(label));
      }

      expect(props.onRename).not.toHaveBeenCalled();
      expect(props.onArchive).not.toHaveBeenCalled();
    });

    it("draws none of what the server has nothing behind, and offers no delete", () => {
      renderSheet();

      for (const text of [
        "Project instructions",
        "What every chat in this project should know",
        "Share project",
        "Invite people from your organization",
        "Delete project",
      ]) {
        expect(screen.queryByText(text)).toBeNull();
      }
      expect(screen.queryByText(/\bchats?\b/i)).toBeNull();
      expect(screen.queryByText(/delete/i)).toBeNull();
    });

    it("closes when the sheet is dragged away", () => {
      const { props } = renderSheet();

      act(() => mockSheet.onDismiss());

      expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it("keeps drawing the menu while the sheet slides away", () => {
      const { props, rerender } = renderSheet();

      rerender(sheet({ ...props, page: null }).element);

      expect(mockSheet.isPresented).toBe(false);
      expect(row("Rename")).toBeTruthy();
    });
  });

  describe("rename", () => {
    const field = () => screen.getByLabelText("Project name");

    it("takes the menu's place in the same sheet", () => {
      const { props, rerender } = renderSheet();
      expect(screen.getAllByTestId("expo-bottom-sheet")).toHaveLength(1);

      rerender(sheet({ ...props, page: "rename" }).element);

      expect(mockSheet.isPresented).toBe(true);
      expect(screen.getAllByTestId("expo-bottom-sheet")).toHaveLength(1);
      expect(screen.queryByTestId("project-menu")).toBeNull();
      expect(screen.queryByTestId("project-menu-grabber")).toBeNull();
      expect(screen.getByTestId("project-name-form")).toBeTruthy();
    });

    it("is titled Rename project, with Save, and opens on the project's name", () => {
      renderSheet({ page: "rename" });

      expect(screen.getByRole("header", { name: "Rename project" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Save" }).props.accessibilityState).toMatchObject({ disabled: true });
      expect(field().props.value).toBe("Portfolio");
      expect(flat(screen.getByTestId("project-name-form"))).toMatchObject({ padding: 16, gap: 16 });
    });

    it("submits a changed name and closes from Cancel", () => {
      const { props } = renderSheet({ page: "rename" });

      fireEvent.changeText(field(), " Case studies ");
      fireEvent.press(screen.getByRole("button", { name: "Save" }));
      expect(props.onSubmitName).toHaveBeenCalledWith("Case studies");

      fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
      expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it("shows the request in flight and, after a failure, the line under the field with the typed name kept", () => {
      const { props, rerender } = renderSheet({ page: "rename" });
      fireEvent.changeText(field(), "Case studies");

      rerender(sheet({ ...props, renaming: true }).element);
      expect(screen.getByRole("button", { name: "Save" }).props.accessibilityState).toMatchObject({ busy: true });
      expect(field().props.editable).toBe(false);

      rerender(sheet({ ...props, renameFailure: "Project could not be renamed. Try again." }).element);
      expect(screen.getByRole("alert").props.children).toBe("Project could not be renamed. Try again.");
      expect(field().props.value).toBe("Case studies");
      expect(mockSheet.isPresented).toBe(true);
    });

    it("keeps drawing the form while the sheet slides away, and starts from the current name the next time", () => {
      const { props, rerender } = renderSheet({ page: "rename" });
      fireEvent.changeText(field(), "Typed and abandoned");

      rerender(sheet({ ...props, page: null }).element);
      expect(field().props.value).toBe("Typed and abandoned");

      rerender(sheet({ ...props, page: "menu", name: "Case studies" }).element);
      rerender(sheet({ ...props, page: "rename", name: "Case studies" }).element);
      expect(field().props.value).toBe("Case studies");
    });
  });
});
