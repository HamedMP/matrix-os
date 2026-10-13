import { cleanup, fireEvent, render, screen, within } from "@testing-library/react-native";
import { FlatList } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { NewAgentScreen, type NewAgentScreenProps } from "../components/agents/NewAgentScreen";
import type { AgentInspiration } from "../components/agents/agent-inspirations.generated";
import type { AgentTemplate } from "../components/agents/agent-templates";
import { AgentMascot } from "../components/ui/AgentMascot";
import { EmptyState } from "../components/ui/EmptyState";
import { Icon } from "../components/ui/Icon";
import { BackIcon, ChevronRightIcon } from "../components/ui/icons";

import { flat, pressedStyle } from "./ui-test-utils";

const templates: AgentTemplate[] = [
  { recipeId: "inbox-triage", version: "v1", name: "Inbox triage", description: "Sorts your inbox and drafts replies" },
  { recipeId: "account-research", version: "v2", name: "Account research", description: "Briefs you before every sales call", category: "sales" },
];
const inspirations: AgentInspiration[] = [
  {
    id: "call-follow-ups",
    name: "Call Follow-Ups",
    categories: ["Sales", "Marketing"],
    description: "Turns a call into the follow-up email and the next steps",
    skills: ["Draft the follow-up"],
    integrations: ["Gmail"],
  },
  {
    id: "overheard",
    name: "Overheard",
    categories: [],
    description: "Collects the best lines of the week",
    skills: [],
    integrations: [],
  },
];
const categories = ["All", "Sales", "Marketing", "Operations"];

function renderScreen(overrides: Partial<NewAgentScreenProps> = {}) {
  const props: NewAgentScreenProps = {
    state: "ready",
    templates,
    inspirations: [],
    query: "",
    onChangeQuery: jest.fn(),
    categories,
    category: "All",
    onChangeCategory: jest.fn(),
    onRetry: jest.fn(),
    onBack: jest.fn(),
    onSelectTemplate: jest.fn(),
    onSelectInspiration: jest.fn(),
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
    // The keyboard would rewrite a template's name, such as "tinkabot", on leaving the field.
    expect(search.props.autoCorrect).toBe(false);
    fireEvent.changeText(search, "sales");
    expect(onChangeQuery).toHaveBeenCalledWith("sales");
  });

  it("offers the categories as one row of chips that scrolls sideways under the screen's edges", () => {
    renderScreen();

    const row = screen.getByTestId("template-categories");
    expect(row.props.horizontal).toBe(true);
    expect(row.props.showsHorizontalScrollIndicator).toBe(false);
    // A press on a chip counts while the keyboard is up.
    expect(row.props.keyboardShouldPersistTaps).toBe("handled");
    // The row reaches both edges of the screen, and starts 20pt in like the rest.
    // It keeps its own height however long the list below it is.
    expect(flat(row)).toMatchObject({ flexGrow: 0, flexShrink: 0, marginHorizontal: -20 });
    expect(flat({ props: { style: row.props.contentContainerStyle } })).toMatchObject({
      gap: 8,
      paddingHorizontal: 20,
    });
    expect(within(row).getAllByRole("button").map((chip) => chip.props.accessibilityLabel)).toEqual(categories);
  });

  it("gives each 36pt chip the rest of its 44pt target above and below", () => {
    renderScreen();

    const row = screen.getByTestId("template-categories");
    expect(flat(row).marginVertical).toBe(-4);
    expect(flat({ props: { style: row.props.contentContainerStyle } }).paddingVertical).toBe(4);
    expect(flat(screen.getByTestId("template-category-Sales")).height).toBe(36);
  });

  it("marks the chosen category, and asks for another when its chip is pressed", () => {
    const { onChangeCategory } = renderScreen({ category: "Marketing" });

    expect(screen.getByTestId("template-category-Marketing").props.accessibilityState).toMatchObject({ selected: true });
    expect(flat(screen.getByTestId("template-category-Marketing")).backgroundColor).toBe("#0D0D0D");
    expect(screen.getByTestId("template-category-All").props.accessibilityState).toMatchObject({ selected: false });
    expect(pressedStyle({ testID: "template-category-Sales" }).opacity).toBeLessThan(1);

    fireEvent.press(screen.getByTestId("template-category-Sales"));

    expect(onChangeCategory).toHaveBeenCalledTimes(1);
    expect(onChangeCategory).toHaveBeenCalledWith("Sales");
  });

  it("shows the list from its top again when another category is chosen or the search changes", () => {
    const scrollToOffset = jest.spyOn(FlatList.prototype, "scrollToOffset").mockImplementation(() => {});
    renderScreen({ inspirations });

    fireEvent.press(screen.getByTestId("template-category-Sales"));
    expect(scrollToOffset).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: false });

    fireEvent.changeText(screen.getByLabelText("Search templates"), "call");
    expect(scrollToOffset).toHaveBeenCalledTimes(2);
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: false });

    // Opening a row leaves the list where it is.
    fireEvent.press(screen.getByTestId("template-row-overheard"));
    expect(scrollToOffset).toHaveBeenCalledTimes(2);
    scrollToOffset.mockRestore();
  });

  it("changes the category and the search while the templates load, when there is no list to move", () => {
    const { onChangeCategory, onChangeQuery } = renderScreen({ state: "loading", templates: [] });

    fireEvent.press(screen.getByTestId("template-category-Sales"));
    fireEvent.changeText(screen.getByLabelText("Search templates"), "call");

    expect(onChangeCategory).toHaveBeenCalledWith("Sales");
    expect(onChangeQuery).toHaveBeenCalledWith("call");
  });

  it("lists the templates 2pt apart, clear of the home indicator", () => {
    renderScreen();

    const list = screen.getByTestId("template-list");
    expect(flat({ props: { style: list.props.contentContainerStyle } })).toMatchObject({
      gap: 2,
      paddingBottom: 34 + 20,
    });
    // The list reaches the screen's edges, which puts its scroll indicator
    // there and not over the chevrons; the rows still start 20pt in.
    expect(flat(list).marginHorizontal).toBe(-20);
    expect(flat({ props: { style: list.props.contentContainerStyle } }).paddingHorizontal).toBe(20);
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

  it("lists the inspirations after the computer's templates, as the same rows", () => {
    renderScreen({ inspirations });

    const rows = screen.getAllByTestId(/^template-row-/).filter((node) => node.props.accessibilityRole === "button");
    expect(rows.map((row) => row.props.testID)).toEqual([
      "template-row-inbox-triage",
      "template-row-account-research",
      "template-row-call-follow-ups",
      "template-row-overheard",
    ]);

    const row = screen.getByTestId("template-row-call-follow-ups");
    expect(row.props.accessibilityLabel).toBe("Call Follow-Ups, Turns a call into the follow-up email and the next steps");
    expect(flat(row).paddingVertical).toBe(12);
    expect(within(row).getByText("Call Follow-Ups")).toBeTruthy();
    expect(within(row).getByText("Turns a call into the follow-up email and the next steps")).toBeTruthy();
    const chevron = within(row).UNSAFE_getAllByType(Icon).find((icon) => icon.props.icon === ChevronRightIcon);
    expect(chevron?.props).toMatchObject({ size: 18, color: "#635F5F" });
  });

  it("colours an inspiration's mascot by its first category, and by its id alone when it has none", () => {
    renderScreen({ inspirations });

    expect(within(screen.getByTestId("template-row-call-follow-ups")).UNSAFE_getByType(AgentMascot).props).toMatchObject({
      id: "call-follow-ups",
      name: "Call Follow-Ups",
      category: "Sales",
    });
    const plain = within(screen.getByTestId("template-row-overheard")).UNSAFE_getByType(AgentMascot).props;
    expect(plain).toMatchObject({ id: "overheard", name: "Overheard" });
    expect(plain.category).toBeUndefined();
  });

  it("hands the pressed inspiration to its own sheet, not to the setup sheet", () => {
    const { onSelectInspiration, onSelectTemplate } = renderScreen({ inspirations });

    fireEvent.press(screen.getByTestId("template-row-overheard"));

    expect(onSelectInspiration).toHaveBeenCalledTimes(1);
    expect(onSelectInspiration).toHaveBeenCalledWith(inspirations[1]);
    expect(onSelectTemplate).not.toHaveBeenCalled();
  });

  it("lists the inspirations alone when the computer has no templates", () => {
    renderScreen({ templates: [], inspirations });

    expect(
      screen.getAllByTestId(/^template-row-/).filter((node) => node.props.accessibilityRole === "button"),
    ).toHaveLength(2);
    expect(screen.UNSAFE_queryByType(EmptyState)).toBeNull();
  });

  it("shows the existing skeleton rows while the templates load", () => {
    renderScreen({ state: "loading", templates: [], inspirations });

    expect(screen.getAllByTestId("template-skeleton-row").length).toBeGreaterThan(0);
    // The inspirations wait too, so the list does not move when the templates arrive above them.
    expect(screen.queryByTestId("template-list")).toBeNull();
    expect(screen.getByLabelText("Search templates")).toBeTruthy();
    expect(screen.getByTestId("template-categories")).toBeTruthy();
  });

  it("reports a failed load in generic words above the list, with a text button to try again", () => {
    const { onRetry } = renderScreen({ state: "error", templates: [], inspirations });

    const line = screen.getByRole("alert");
    expect(line.props.children).toBe("Some templates could not be loaded.");
    expect(flat(line)).toMatchObject({ fontSize: 14, lineHeight: 20, color: "#635F5F", textAlign: "center" });
    expect(flat(screen.getByTestId("template-error"))).toMatchObject({ alignItems: "center", gap: 4, paddingBottom: 8 });
    // What the app ships with is still there to start from.
    expect(within(screen.getByTestId("template-list")).getByTestId("template-error")).toBeTruthy();
    expect(screen.getByTestId("template-row-call-follow-ups")).toBeTruthy();

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

  it("does not draw Start from scratch, which the server has nothing behind", () => {
    renderScreen({ inspirations });

    expect(screen.queryByText("Start from scratch")).toBeNull();
    expect(screen.queryByText("Describe it in your own words")).toBeNull();
  });
});
