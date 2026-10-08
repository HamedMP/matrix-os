import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react-native";

import { AgentsListFrame, NewAgentFrame, TemplateSetupFrame } from "../dev/design-preview/agents";
import { DesignPreview } from "../dev/design-preview/DesignPreview";
import { AgentMascot } from "../components/ui/AgentMascot";
import { StatusDot } from "../components/ui/StatusDot";
import { deriveAgentMascot } from "../lib/agent-mascot";

const mockSetParams = jest.fn();
let mockSheet: { isPresented: boolean } = { isPresented: false };

jest.mock("expo-router", () => ({ useRouter: () => ({ setParams: mockSetParams }) }));
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

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
function rows(prefix: "agent-row-" | "template-row-"): Row[] {
  return screen.getAllByTestId(new RegExp(`^${prefix}`)).filter((node) => node.props.accessibilityRole === "button");
}

function textsOf(row: Row): string[] {
  return within(row).getAllByText(/./).map((node) => node.props.children);
}

function mascotColor(row: Row) {
  const { id, category } = within(row).UNSAFE_getByType(AgentMascot).props;
  return deriveAgentMascot(id, category).color;
}

describe("agents design frames", () => {
  beforeEach(() => {
    mockSheet = { isPresented: false };
  });

  afterEach(cleanup);

  it("A1 lists the frame's four agents with their status lines, times and mascot colours", () => {
    render(<AgentsListFrame />);

    expect(rows("agent-row-").map(textsOf)).toEqual([
      ["Account research", "Waiting for your approval", "2m"],
      ["My inbox", "3 drafts ready to review", "9:12"],
      ["Competitor watch", "Reading sources…", "now"],
      ["Launch tracker", "Tracks what is left before launch", "Mon"],
    ]);
    expect(rows("agent-row-").map(mascotColor)).toEqual(["coral", "teal", "blue", "amber"]);
  });

  it("A1 marks the first agent as waiting and the next two as active", () => {
    render(<AgentsListFrame />);

    const tones = rows("agent-row-").map(
      (row) => within(row).UNSAFE_queryByType(StatusDot)?.props.tone ?? null,
    );
    expect(tones).toEqual(["waiting", "active", "active", null]);
  });

  it("A1 shows the fourth agent's description where the frame says Paused", () => {
    render(<AgentsListFrame />);

    expect(screen.queryByText("Paused")).toBeNull();
  });

  it("A1 sits above the app's tab bar, on Agents, with two agents waiting", () => {
    render(<AgentsListFrame />);

    const tab = screen.getByRole("tab", { name: "Agents, 2 waiting" });
    expect(tab.props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByTestId("tab-badge-agents-count")).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(5);
  });

  it("A5 lists the frame's five templates and nothing the server lacks", () => {
    render(<NewAgentFrame />);

    expect(screen.getByRole("header", { name: "What should your agent do?" })).toBeTruthy();
    expect(rows("template-row-").map(textsOf)).toEqual([
      ["Inbox triage", "Sorts your inbox and drafts replies"],
      ["Daily planner", "Plans your day around meetings"],
      ["Account research", "Briefs you before every sales call"],
      ["Competitor watch", "Tells you when competitors change"],
      ["Meeting follow-up", "Turns notes into owners and next steps"],
    ]);
    expect(rows("template-row-").map(mascotColor)).toEqual(["teal", "teal", "coral", "blue", "amber"]);
    expect(screen.queryByText("Start from scratch")).toBeNull();
    expect(screen.queryByText("Personal")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(mockSheet.isPresented).toBe(false);
  });

  it("A5 filters as its search field is typed in", () => {
    render(<NewAgentFrame />);

    fireEvent.changeText(screen.getByLabelText("Search templates"), "competitors");

    expect(rows("template-row-")).toHaveLength(1);
    expect(screen.getByTestId("template-row-competitor-watch")).toBeTruthy();
  });

  it("A5b opens the setup sheet for Account research over the template list", () => {
    render(<TemplateSetupFrame />);

    expect(mockSheet.isPresented).toBe(true);
    const sheet = screen.getByTestId("expo-bottom-sheet");
    expect(within(sheet).getByRole("header", { name: "Account research" })).toBeTruthy();
    expect(within(sheet).getByText("Briefs you before every sales call")).toBeTruthy();
    expect(within(sheet).getByLabelText("Name").props.value).toBe("Account research");
    expect(within(sheet).getByRole("button", { name: "Create agent" })).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Set up in chat instead" })).toBeTruthy();
    expect(screen.getByTestId("template-row-inbox-triage")).toBeTruthy();
  });

  it("A5b leaves out the apps list and the run options", () => {
    render(<TemplateSetupFrame />);

    for (const text of ["Web search", "Google Calendar", "Google Drive", "Connect", "When I ask", "Before each meeting"]) {
      expect(screen.queryByText(text)).toBeNull();
    }
    expect(screen.queryByRole("header", { name: "Apps" })).toBeNull();
    expect(screen.queryByRole("header", { name: "Runs" })).toBeNull();
  });

  it("is listed in the design preview after C2, and each name opens its frame", () => {
    render(<DesignPreview frame={undefined} />);
    const names = screen.getAllByRole("button").map((button) => within(button).getByText(/./).props.children);
    expect(names.slice(names.indexOf("C2"))).toEqual(["C2", "A1", "A5", "A5b"]);
    fireEvent.press(screen.getByRole("button", { name: "A5b" }));
    expect(mockSetParams).toHaveBeenCalledWith({ frame: "A5b" });
    cleanup();

    render(<DesignPreview frame="A1" />);
    expect(screen.getByRole("header", { name: "Agents" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Agents, 2 waiting" })).toBeTruthy();
    cleanup();

    render(<DesignPreview frame="A5" />);
    expect(screen.getByRole("header", { name: "What should your agent do?" })).toBeTruthy();
    expect(mockSheet.isPresented).toBe(false);
    cleanup();

    render(<DesignPreview frame="A5b" />);
    expect(mockSheet.isPresented).toBe(true);
    expect(screen.getByLabelText("Name").props.value).toBe("Account research");
  });
});
