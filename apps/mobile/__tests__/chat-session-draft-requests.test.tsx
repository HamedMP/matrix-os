import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { Pressable, Text } from "react-native";

import { CanonicalChatSessionProvider, useCanonicalChatSession } from "../lib/canonical-chat-session-context";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ getToken: jest.fn(), userId: "user_a" }) }));
jest.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
jest.mock("@/lib/queries/use-canonical-chats", () => ({ useCanonicalChats: () => ({ computer: undefined }) }));

/** Shows the session as "<chat>:<requests>:<project>" and offers each way of changing it. */
function Probe() {
  const session = useCanonicalChatSession();
  const actions = {
    "new chat": () => session.startDraftChat(),
    "new chat in project": () => session.startDraftChat("project_a"),
    "open chat": () => session.selectChat("chat_a"),
    "bind chat": () => session.bindDraftChatId("chat_b"),
  };
  return (
    <>
      <Text>{`${session.activeChatId ?? "draft"}:${session.draftChatRequests}:${session.selectedProjectId ?? "none"}`}</Text>
      {Object.entries(actions).map(([label, onPress]) => (
        <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} />
      ))}
    </>
  );
}

function press(label: string) {
  fireEvent.press(screen.getByRole("button", { name: label }));
}

describe("draft chat requests", () => {
  afterEach(cleanup);

  it("counts every time the person asks for a new chat, even when one is already open", () => {
    render(<CanonicalChatSessionProvider><Probe /></CanonicalChatSessionProvider>);
    expect(screen.getByText("draft:0:none")).toBeTruthy();

    press("new chat");
    expect(screen.getByText("draft:1:none")).toBeTruthy();

    press("new chat in project");
    expect(screen.getByText("draft:2:project_a")).toBeTruthy();
  });

  it("does not count opening a chat or binding the chat a draft became", () => {
    render(<CanonicalChatSessionProvider><Probe /></CanonicalChatSessionProvider>);

    press("open chat");
    expect(screen.getByText("chat_a:0:none")).toBeTruthy();

    press("bind chat");
    expect(screen.getByText("chat_b:0:none")).toBeTruthy();

    press("new chat");
    expect(screen.getByText("draft:1:none")).toBeTruthy();
  });

  it("is zero for a screen outside the provider", () => {
    render(<Probe />);

    expect(screen.getByText("draft:0:none")).toBeTruthy();
  });
});
