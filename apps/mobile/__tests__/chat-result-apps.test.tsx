import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";

import { ReplyResultApps } from "../components/chat/ReplyResultApps";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

const mockReadCatalog = jest.fn();
let mockApps: Record<string, unknown>[] = [];

jest.mock("@/lib/queries/use-computer-apps", () => ({
  useComputerApps: () => {
    mockReadCatalog();
    return { apps: mockApps };
  },
  installedAppSlug: (app: { file?: string; slug?: string; name: string }) => (
    app.file?.split("/")[1] ?? app.slug ?? app.name.toLowerCase()
  ),
}));

const habitTracker = {
  name: "Habit tracker", slug: "habit-tracker", category: "productivity",
  file: "apps/habit-tracker/index.html", path: "apps/habit-tracker/index.html",
};
const notes = { name: "Notes", slug: "notes", file: "apps/notes/index.html", path: "apps/notes/index.html" };

describe("ReplyResultApps", () => {
  beforeEach(() => {
    mockApps = [habitTracker, notes];
  });

  afterEach(() => {
    cleanup();
    mockReadCatalog.mockClear();
  });

  it("shows a card under a reply that refers to an app in the catalog", () => {
    render(<ReplyResultApps text="Saved it to `~/apps/habit-tracker`." allowRelative onOpen={jest.fn()} />);

    expect(screen.getByTestId("result-card")).toBeTruthy();
    expect(screen.getByText("Habit tracker")).toBeTruthy();
  });

  it("says the result is an app, with the catalog's category when it has one", () => {
    render(<ReplyResultApps text="`~/apps/habit-tracker` and `~/apps/notes`" allowRelative onOpen={jest.fn()} />);

    expect(screen.getAllByTestId("result-card")).toHaveLength(2);
    expect(screen.getByText("App · Productivity")).toBeTruthy();
    expect(screen.getByText("App")).toBeTruthy();
  });

  it("opens the app by its identity, naming the installed copy as the Apps screen does", () => {
    // A migrated app keeps its file identity while the catalog lists it under another slug.
    mockApps = [{ ...habitTracker, slug: "habits" }];
    const onOpen = jest.fn();
    render(<ReplyResultApps text="Saved it to `~/apps/habit-tracker`." allowRelative onOpen={onOpen} />);

    fireEvent.press(screen.getByRole("button", { name: "Open Habit tracker" }));

    expect(onOpen).toHaveBeenCalledWith({
      slug: "habit-tracker", runtimeSlug: "habits", name: "Habit tracker", detail: "App · Productivity",
    });
  });

  it("shows no card when the reference is not an app the catalog knows", () => {
    render(<ReplyResultApps text="Saved it to `~/apps/unknown-app`." allowRelative onOpen={jest.fn()} />);

    expect(screen.queryByTestId("result-card")).toBeNull();
  });

  it("shows no card, and leaves the catalog alone, for a reply that names no app path", () => {
    render(<ReplyResultApps text="Done. It has a daily checklist and shows your streak for each habit." allowRelative onOpen={jest.fn()} />);

    expect(screen.queryByTestId("result-card")).toBeNull();
    expect(mockReadCatalog).not.toHaveBeenCalled();
  });

  it("does not take a bare relative path for an app where the reply's files are not the home folder", () => {
    render(<ReplyResultApps text="Created `apps/habit-tracker`." allowRelative={false} onOpen={jest.fn()} />);

    expect(screen.queryByTestId("result-card")).toBeNull();
  });

  it("hands Open the app's slug and name for the preview route", () => {
    const onOpen = jest.fn();
    render(<ReplyResultApps text="Saved it to `~/apps/habit-tracker`." allowRelative onOpen={onOpen} />);

    fireEvent.press(screen.getByRole("button", { name: "Open Habit tracker" }));

    expect(onOpen).toHaveBeenCalledWith({
      slug: "habit-tracker", runtimeSlug: "habit-tracker", name: "Habit tracker", detail: "App · Productivity",
    });
  });
});
