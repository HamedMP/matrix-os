import { cleanup, fireEvent, render, screen, within } from "@testing-library/react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { ProjectsListScreen, type ProjectsListScreenProps } from "../components/projects/ProjectsListScreen";
import type { ProjectRow } from "../components/projects/project-rows";
import { EmptyState } from "../components/ui/EmptyState";
import { Icon } from "../components/ui/Icon";
import { IconTile } from "../components/ui/IconTile";
import { AddIcon, BackIcon, ChevronRightIcon, FolderIcon } from "../components/ui/icons";

import { flat } from "./ui-test-utils";

const rows: ProjectRow[] = [
  { id: "proj_portfolio", name: "Portfolio", updated: "Updated today" },
  { id: "proj_matrix", name: "Matrix", updated: "Updated yesterday" },
  { id: "proj_notes", name: "Field notes" },
];

function renderList(overrides: Partial<ProjectsListScreenProps> = {}) {
  const props: ProjectsListScreenProps = {
    state: "ready",
    rows,
    query: "",
    onChangeQuery: jest.fn(),
    refreshing: false,
    onRefresh: jest.fn(),
    onRetry: jest.fn(),
    onBack: jest.fn(),
    onNewProject: jest.fn(),
    onOpenProject: jest.fn(),
    ...overrides,
  };
  render(
    <SafeAreaInsetsContext.Provider value={{ top: 62, right: 0, bottom: 34, left: 0 }}>
      <ProjectsListScreen {...props} />
    </SafeAreaInsetsContext.Provider>,
  );
  return props;
}

describe("projects list screen", () => {
  afterEach(cleanup);

  it("starts below the status bar on the background colour", () => {
    renderList();

    expect(flat(screen.getByTestId("projects-screen"))).toMatchObject({ paddingTop: 62, backgroundColor: "#FFFEFC" });
  });

  it("goes back from a 44pt button with a 22pt chevron at the left of the top bar", () => {
    const { onBack } = renderList();

    const bar = screen.getByTestId("projects-top-bar");
    expect(flat(bar)).toMatchObject({ height: 52, paddingHorizontal: 8 });
    const back = within(screen.getByTestId("projects-top-bar-leading")).getByRole("button", { name: "Back" });
    expect(flat(back)).toMatchObject({ width: 44, height: 44 });
    expect(within(back).UNSAFE_getByType(Icon).props).toMatchObject({ icon: BackIcon, size: 22 });

    fireEvent.press(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("offers New project as a secondary button with the add icon at the right of the top bar", () => {
    const { onNewProject } = renderList();

    const button = within(screen.getByTestId("projects-top-bar-trailing")).getByRole("button", { name: "New project" });
    expect(flat(button)).toMatchObject({ height: 44, backgroundColor: "#F5F5F5" });
    expect(within(button).UNSAFE_getByType(Icon).props.icon).toBe(AddIcon);

    fireEvent.press(button);
    expect(onNewProject).toHaveBeenCalledTimes(1);
  });

  it("has no title in the top bar: the large title below it is the only heading", () => {
    renderList();

    expect(within(screen.getByTestId("projects-top-bar")).queryByRole("header")).toBeNull();
    expect(screen.getAllByRole("header")).toHaveLength(1);
    expect(flat(screen.getByRole("header", { name: "Projects" }))).toMatchObject({
      fontFamily: "Geist_600SemiBold",
      fontSize: 30,
      lineHeight: 41,
      color: "#242323",
    });
  });

  it("sets the title, the search field and the list 20pt in and 16pt apart, 6pt under the top bar", () => {
    renderList();

    const body = screen.getByTestId("projects-body");
    expect(flat(body)).toMatchObject({ flex: 1, paddingHorizontal: 20, paddingTop: 6, gap: 16 });
    expect(body.children).toHaveLength(3);
    expect(within(body).getByRole("header", { name: "Projects" })).toBeTruthy();
    expect(within(body).getByLabelText("Search projects")).toBeTruthy();
    expect(within(body).getByTestId("projects-list")).toBeTruthy();
  });

  it("shows the search and reports what is typed in it", () => {
    const { onChangeQuery } = renderList({ query: "port" });

    const field = screen.getByLabelText("Search projects");
    expect(field.props.value).toBe("port");
    expect(field.props.placeholder).toBe("Search projects");

    fireEvent.changeText(field, "portf");
    expect(onChangeQuery).toHaveBeenCalledWith("portf");
  });

  it("lists the projects with no space between their rows", () => {
    renderList();

    const list = screen.getByTestId("projects-list");
    const content = flat({ props: { style: list.props.contentContainerStyle } });
    expect(content).toMatchObject({ flexGrow: 1, paddingBottom: 20 });
    expect(content.gap).toBeUndefined();
    expect(list.props.ItemSeparatorComponent).toBeUndefined();
    expect(screen.getAllByTestId(/^project-row-[a-z_]+$/)).toHaveLength(3);
  });

  it("draws a project as a comfortable row: a 44pt folder tile 14pt from its name, over when it last changed", () => {
    renderList();

    const row = screen.getByTestId("project-row-proj_portfolio");
    expect(flat(row)).toMatchObject({ flexDirection: "row", alignItems: "center", paddingVertical: 12 });
    expect(within(row).UNSAFE_getByType(IconTile).props).toMatchObject({ icon: FolderIcon, size: 44 });
    expect(flat(screen.getByTestId("project-row-proj_portfolio-leading")).marginRight).toBe(14);
    expect(flat(within(row).getByText("Portfolio"))).toMatchObject({
      fontFamily: "Geist_500Medium",
      fontSize: 16,
      lineHeight: 22,
      color: "#242323",
    });
    expect(flat(within(row).getByText("Updated today"))).toMatchObject({
      fontFamily: "Geist_400Regular",
      fontSize: 13,
      lineHeight: 18,
      color: "#635F5F",
    });
  });

  it("ends each row with an 18pt chevron in the secondary text colour", () => {
    renderList();

    const icons = within(screen.getByTestId("project-row-proj_matrix")).UNSAFE_getAllByType(Icon);
    expect(icons.at(-1)?.props).toMatchObject({ icon: ChevronRightIcon, size: 18, color: "#635F5F" });
  });

  it("leaves the second line out for a project whose time is not known", () => {
    renderList();

    const row = screen.getByTestId("project-row-proj_notes");
    expect(within(row).getAllByText(/./).map((node) => node.props.children)).toEqual(["Field notes"]);
    expect(row.props.accessibilityLabel).toBe("Field notes");
  });

  it("opens the project whose row is pressed, and names the row once for a screen reader", () => {
    const { onOpenProject } = renderList();

    const row = screen.getByTestId("project-row-proj_matrix");
    expect(row.props.accessibilityRole).toBe("button");
    expect(row.props.accessibilityLabel).toBe("Matrix, Updated yesterday");
    fireEvent.press(row);

    expect(onOpenProject).toHaveBeenCalledWith("proj_matrix");
  });

  it("shows no chat count anywhere", () => {
    renderList();

    expect(screen.queryByText(/\bchats?\b/i)).toBeNull();
  });

  it("reads the list again when it is pulled down", () => {
    const { onRefresh } = renderList({ refreshing: true });

    const list = screen.getByTestId("projects-list");
    expect(list.props.refreshing).toBe(true);
    fireEvent(list, "refresh");

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the keyboard out of the way of the rows", () => {
    renderList();

    expect(screen.getByTestId("projects-list").props).toMatchObject({
      keyboardShouldPersistTaps: "handled",
      keyboardDismissMode: "on-drag",
    });
  });

  it("shows the existing skeleton rows while the projects load", () => {
    renderList({ state: "loading", rows: [] });

    expect(screen.getAllByTestId("project-skeleton-row").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("projects-list")).toBeNull();
    expect(screen.getByRole("button", { name: "New project" })).toBeTruthy();
  });

  it("says in generic words, with a retry, that the projects could not be loaded", () => {
    const { onRetry } = renderList({ state: "error", rows: [] });

    const line = screen.getByRole("alert");
    expect(line.props.children).toBe("Projects could not be loaded.");
    expect(flat(line)).toMatchObject({ fontSize: 14, lineHeight: 20, color: "#635F5F", textAlign: "center" });
    expect(screen.queryByTestId("projects-list")).toBeNull();

    fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state with a New project action when there are no projects", () => {
    const { onNewProject } = renderList({ rows: [] });

    const empty = screen.getByTestId("projects-empty");
    expect(within(empty).UNSAFE_getByType(EmptyState).props).toMatchObject({ icon: FolderIcon, message: "No projects yet" });
    expect(screen.queryByTestId(/^project-row-/)).toBeNull();

    const action = within(empty).getByRole("button", { name: "New project" });
    expect(flat(action).height).toBeGreaterThanOrEqual(44);
    fireEvent.press(action);
    expect(onNewProject).toHaveBeenCalledTimes(1);
  });

  it("says no project matches when a search finds none, without offering a new one there", () => {
    renderList({ rows: [], query: "zebra" });

    const line = screen.getByText("No projects match that search.");
    expect(flat(line)).toMatchObject({ fontSize: 14, lineHeight: 20, color: "#635F5F", textAlign: "center" });
    expect(screen.queryByTestId("projects-empty")).toBeNull();
    expect(screen.getAllByRole("button", { name: "New project" })).toHaveLength(1);
  });
});
