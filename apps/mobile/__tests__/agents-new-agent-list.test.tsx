import { cleanup, fireEvent, render, screen, within } from "@testing-library/react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { NewAgentScreen, type NewAgentScreenProps } from "../components/agents/NewAgentScreen";
import type { AgentTemplate } from "../components/agents/agent-templates";
import { AgentMascot } from "../components/ui/AgentMascot";
import { EmptyState } from "../components/ui/EmptyState";
import { Icon } from "../components/ui/Icon";
import { BackIcon, ChevronRightIcon } from "../components/ui/icons";

import { flat } from "./ui-test-utils";

const templates: AgentTemplate[] = [
  { recipeId: "inbox-triage", version: "v1", name: "Inbox triage", description: "Sorts your inbox and drafts replies" },
  { recipeId: "account-research", version: "v2", name: "Account research", description: "Briefs you before every sales call", category: "sales" },
];

function renderScreen(overrides: Partial<NewAgentScreenProps> = {}) {
  const props: NewAgentScreenProps = {
    state: "ready",
    templates,
    query: "",
    onChangeQuery: jest.fn(),
    onRetry: jest.fn(),
    onBack: jest.fn(),
    onSelectTemplate: jest.fn(),
    ...overrides,
  };
  render(
    <SafeAreaInsetsContext.Provider value={{ top: 62, right: 0, bottom: 34, left: 0 }}>
      <NewAgentScreen {...props} />
    </SafeAreaInsetsContext.Provider>,
  );
  return props;
}

describe("new agent screen", () => {
  afterEach(cleanup);

  it("starts below the status bar on the background colour", () => {
    renderScreen();

    expect(flat(screen.getByTestId("new-agent-screen"))).toMatchObject({ paddingTop: 62, backgroundColor: "#FFFEFC" });
  });

  it("has a start-aligned top bar: a 22pt back chevron in a 44pt target, then the title", () => {
    const { onBack } = renderScreen();

    const bar = screen.getByTestId("new-agent-top-bar");
    expect(flat(bar)).toMatchObject({ height: 52, paddingHorizontal: 8, gap: 10 });
    const title = within(bar).getByRole("header", { name: "New agent" });
    expect(flat(title)).toMatchObject({ fontFamily: "Geist_600SemiBold", fontSize: 16, lineHeight: 22 });
    expect(flat(title).textAlign).toBeUndefined();

    const back = within(bar).getByRole("button", { name: "Back" });
    expect(flat(back)).toMatchObject({ width: 44, height: 44 });
    expect(within(back).UNSAFE_getByType(Icon).props).toMatchObject({ icon: BackIcon, size: 22 });
    fireEvent.press(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("lays the body out 20pt in, with 16pt between its blocks", () => {
    renderScreen();

    expect(flat(screen.getByTestId("new-agent-body"))).toMatchObject({
      flex: 1,
      paddingTop: 8,
      paddingHorizontal: 20,
      gap: 16,
    });
  });

  it("asks what the agent should do in the heading style", () => {
    renderScreen();

    expect(flat(screen.getByRole("header", { name: "What should your agent do?" }))).toMatchObject({
      fontFamily: "Geist_600SemiBold",
      fontSize: 24,
      lineHeight: 34,
      color: "#242323",
    });
  });

  it("searches templates through the shared search field", () => {
    const { onChangeQuery } = renderScreen({ query: "inbox" });

    const search = screen.getByLabelText("Search templates");
    expect(search.props.placeholder).toBe("Search templates");
    expect(search.props.value).toBe("inbox");
    fireEvent.changeText(search, "sales");
    expect(onChangeQuery).toHaveBeenCalledWith("sales");
  });

  it("lists the templates 2pt apart, clear of the home indicator", () => {
    renderScreen();

    const list = screen.getByTestId("template-list");
    expect(flat({ props: { style: list.props.contentContainerStyle } })).toMatchObject({
      gap: 2,
      paddingBottom: 34 + 20,
    });
    expect(
      screen.getAllByTestId(/^template-row-/).filter((node) => node.props.accessibilityRole === "button"),
    ).toHaveLength(2);
  });

  it("draws each template as a comfortable row: 36pt mascot, name, description and an 18pt chevron", () => {
    renderScreen();

    const row = screen.getByTestId("template-row-account-research");
    expect(row.props.accessibilityRole).toBe("button");
    expect(row.props.accessibilityLabel).toBe("Account research, Briefs you before every sales call");
    expect(flat(row).paddingVertical).toBe(12);
    expect(within(row).UNSAFE_getByType(AgentMascot).props).toMatchObject({
      id: "account-research",
      name: "Account research",
      category: "sales",
    });
    expect(flat(within(row).getByRole("image", { name: "Account research" }))).toMatchObject({ width: 36, height: 36 });
    expect(within(row).getByText("Account research")).toBeTruthy();
    expect(within(row).getByText("Briefs you before every sales call")).toBeTruthy();
    const chevron = within(row).UNSAFE_getAllByType(Icon).find((icon) => icon.props.icon === ChevronRightIcon);
    expect(chevron?.props).toMatchObject({ size: 18, color: "#635F5F" });
  });

  it("hands the pressed template to the setup sheet", () => {
    const { onSelectTemplate } = renderScreen();

    fireEvent.press(screen.getByTestId("template-row-inbox-triage"));

    expect(onSelectTemplate).toHaveBeenCalledWith(templates[0]);
  });

  it("shows the existing skeleton rows while the templates load", () => {
    renderScreen({ state: "loading", templates: [] });

    expect(screen.getAllByTestId("template-skeleton-row").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("template-list")).toBeNull();
    expect(screen.getByLabelText("Search templates")).toBeTruthy();
  });

  it("reports a failed load in generic words, with a text button to try again", () => {
    const { onRetry } = renderScreen({ state: "error", templates: [] });

    const line = screen.getByRole("alert");
    expect(line.props.children).toBe("Templates could not be loaded.");
    expect(flat(line)).toMatchObject({ fontSize: 14, lineHeight: 20, color: "#635F5F", textAlign: "center" });
    expect(flat(screen.getByTestId("template-error"))).toMatchObject({ alignItems: "center", gap: 4 });
    expect(screen.queryByTestId("template-list")).toBeNull();

    const retry = within(screen.getByTestId("template-error")).getByRole("button", { name: "Try again" });
    expect(flat(retry).height).toBe(44);
    expect(flat(retry).backgroundColor).toBeUndefined();
    expect(flat(retry).borderWidth).toBeUndefined();
    fireEvent.press(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("offers no retry while the templates load or once they are listed", () => {
    renderScreen({ state: "loading", templates: [] });
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    cleanup();

    renderScreen();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("uses the empty state for a search that matches nothing", () => {
    renderScreen({ templates: [], query: "zzz" });

    expect(screen.UNSAFE_getByType(EmptyState).props.message).toBe("No templates match that search.");
    expect(screen.queryByTestId(/^template-row-/)).toBeNull();
  });

  it("uses the empty state when there are no templates at all", () => {
    renderScreen({ templates: [], query: "  " });

    expect(screen.UNSAFE_getByType(EmptyState).props.message).toBe("No templates yet.");
  });

  it("draws none of the controls the server has nothing behind", () => {
    renderScreen();

    expect(screen.queryByText("Start from scratch")).toBeNull();
    expect(screen.queryByText("Describe it in your own words")).toBeNull();
    for (const category of ["All", "Personal", "Sales", "Marketing", "Ops"]) {
      expect(screen.queryByText(category)).toBeNull();
    }
  });
});
