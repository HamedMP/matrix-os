import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";

import { SidePanel } from "../components/shell/SidePanel";

import { C2_CHATS, NOW, chatRecord, chatRows, search, typeSearch, wait } from "./side-panel-test-utils";

const SERVER_RESULTS = [
  // Also a title match among the loaded chats: listed once, in its first place.
  C2_CHATS[2],
  chatRecord({ id: "chat-budget", title: "Budget review", lastMessagePreview: "Planning the next quarter" }),
];

interface HarnessProps {
  chats?: CanonicalChatRecord[];
  results?: CanonicalChatRecord[];
  searching?: boolean;
  failed?: boolean;
  onQuery?: (query: string) => void;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  loadMoreFailed?: boolean;
}

/** Stands in for the route: keeps the query the panel reports and answers it. */
function Harness({
  chats = C2_CHATS,
  results = [],
  searching = false,
  failed = false,
  onQuery,
  onLoadMore,
  loadingMore,
  loadMoreFailed,
}: HarnessProps) {
  const [query, setQuery] = useState("");
  return (
    <SidePanel
      chats={chats}
      projectCount={3}
      now={NOW}
      searchQuery={query}
      searchResults={query ? results : []}
      searching={query !== "" && searching}
      searchFailed={query !== "" && failed}
      loadingMore={loadingMore}
      loadMoreFailed={loadMoreFailed}
      onSearchQueryChange={(next) => {
        onQuery?.(next);
        setQuery(next);
      }}
      onLoadMore={onLoadMore}
      onNewChat={jest.fn()}
      onSelectChat={jest.fn()}
      onOpenProjects={jest.fn()}
      onOpenShared={jest.fn()}
    />
  );
}

describe("SidePanel search", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  it("searches 300 ms after typing stops, with the space around the query removed", () => {
    const onQuery = jest.fn();
    render(<Harness onQuery={onQuery} />);

    typeSearch(" pl");
    wait(299);
    typeSearch(" plan ");
    wait(299);
    expect(onQuery).not.toHaveBeenCalled();
    expect(screen.getByText("Recent")).toBeTruthy();

    wait(1);
    expect(onQuery).toHaveBeenCalledTimes(1);
    expect(onQuery).toHaveBeenCalledWith("plan");
    expect(screen.getByLabelText("Search chats").props.value).toBe(" plan ");
  });

  it("returns to the groups as soon as the field is cleared", () => {
    const onQuery = jest.fn();
    render(<Harness onQuery={onQuery} />);
    search("plan");
    expect(screen.queryByText("Recent")).toBeNull();

    fireEvent.press(screen.getByLabelText("Clear Search chats"));

    expect(onQuery).toHaveBeenLastCalledWith("");
    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(screen.getByText("Recent")).toBeTruthy();
  });

  it("drops a search that was still waiting when the field is cleared", () => {
    const onQuery = jest.fn();
    render(<Harness onQuery={onQuery} />);

    typeSearch("plan");
    wait(100);
    typeSearch("  ");
    wait(1_000);

    expect(onQuery.mock.calls).toEqual([[""]]);
  });

  it("drops a search that was still waiting when the panel unmounts", () => {
    const onQuery = jest.fn();
    render(<Harness onQuery={onQuery} />);

    typeSearch("plan");
    cleanup();
    wait(1_000);

    expect(onQuery).not.toHaveBeenCalled();
  });

  it("shows one list in place of the groups: the title matches, then the server's other results", () => {
    render(<Harness results={SERVER_RESULTS} />);

    search("PLAN");

    expect(chatRows()).toEqual(["side-panel-chat-chat-q4", "side-panel-chat-chat-budget"]);
    expect(screen.getAllByRole("header").map((header) => header.props.children)).toEqual(["Chats"]);
    expect(screen.queryByTestId("side-panel-needs-you")).toBeNull();
    expect(screen.getByTestId("side-panel-projects")).toBeTruthy();
    expect(screen.queryByText("No chats found")).toBeNull();
  });

  it("still marks a found chat that needs the person", () => {
    render(<Harness />);

    search("weekly");

    expect(chatRows()).toEqual(["side-panel-chat-chat-weekly"]);
    expect(screen.getAllByTestId("side-panel-waiting-dot")).toHaveLength(1);
  });

  it("shows skeleton rows under the title matches while the server searches", () => {
    render(<Harness searching results={SERVER_RESULTS} />);

    search("plan");

    expect(chatRows()).toEqual(["side-panel-chat-chat-q4", "side-panel-chat-chat-budget"]);
    expect(screen.getAllByTestId("recent-chat-skeleton-row")).toHaveLength(3);
    expect(screen.queryByText("No chats found")).toBeNull();
  });

  it("says so when nothing matches", () => {
    render(<Harness />);

    search("zebra");

    expect(chatRows()).toEqual([]);
    expect(screen.getByText("No chats found")).toBeTruthy();
    expect(screen.queryByTestId("recent-chat-skeleton-row")).toBeNull();
  });

  it("shows a generic line when the search fails, under the title matches", () => {
    render(<Harness failed />);

    search("plan");

    expect(chatRows()).toEqual(["side-panel-chat-chat-q4"]);
    expect(screen.getByRole("alert").props.children).toBe("Search unavailable. Try again.");
    expect(screen.queryByText("No chats found")).toBeNull();
  });
});

describe("SidePanel older chats", () => {
  afterEach(cleanup);

  it("asks for older chats when the list nears its end", () => {
    const onLoadMore = jest.fn();
    render(<Harness onLoadMore={onLoadMore} />);

    fireEvent(screen.getByTestId("side-panel"), "endReached");

    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("does not ask while a search is shown", () => {
    jest.useFakeTimers();
    const onLoadMore = jest.fn();
    render(<Harness onLoadMore={onLoadMore} />);
    search("plan");

    fireEvent(screen.getByTestId("side-panel"), "endReached");

    expect(onLoadMore).not.toHaveBeenCalled();
    cleanup();
    jest.useRealTimers();
  });

  it("shows skeleton rows after the chats while older ones load", () => {
    render(<Harness loadingMore />);

    expect(screen.getByTestId("side-panel-chat-chat-q4")).toBeTruthy();
    expect(screen.getAllByTestId("recent-chat-skeleton-row")).toHaveLength(3);
  });

  it("stops asking by itself after a failure and offers to try again", () => {
    const onLoadMore = jest.fn();
    render(<Harness onLoadMore={onLoadMore} loadMoreFailed />);

    fireEvent(screen.getByTestId("side-panel"), "endReached");
    expect(onLoadMore).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").props.children).toBe("Older chats unavailable.");

    fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
