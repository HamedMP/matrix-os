import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { Pressable, Text } from "react-native";

import { CanonicalChatSessionProvider, useCanonicalChatSession } from "../lib/canonical-chat-session-context";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
let mockUserId: string | null = "user_a";
let mockComputer: { handle: string; runtimeSlot: string; gatewayPath: string } | undefined;
jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ getToken: jest.fn(), userId: mockUserId }) }));
jest.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
jest.mock("@/lib/queries/use-canonical-chats", () => ({ useCanonicalChats: () => ({ computer: mockComputer }) }));
// With a computer the provider opens the chat event stream; nothing here needs it.
jest.mock("@/lib/canonical-chat-events", () => ({
  createCanonicalChatEventSource: () => ({
    subscribe: () => () => {},
    subscribeLive: () => () => {},
    connect: () => {},
    disconnect: () => {},
  }),
}));
jest.mock("@/lib/canonical-chat-cache-sync", () => ({
  createCanonicalChatCacheSync: () => ({ handle: () => {}, setActiveChat: () => {}, dispose: () => {} }),
}));

const COMPUTER_A = { handle: "aminmeshk", runtimeSlot: "primary", gatewayPath: "/vm/aminmeshk" };
const COMPUTER_B = { handle: "aminmeshk-test", runtimeSlot: "primary", gatewayPath: "/vm/aminmeshk-test" };

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

/** Shows the permission mode chosen for the chat on screen, and offers each way of changing the chat. */
function PermissionProbe() {
  const session = useCanonicalChatSession();
  const actions = {
    "choose full access": () => session.setPermissionModeOverride("full_access"),
    "new chat": () => session.startDraftChat(),
    "open chat": () => session.selectChat("chat_a"),
    "bind chat": () => session.bindDraftChatId("chat_b"),
  };
  return (
    <>
      <Text>{`mode:${session.permissionModeOverride ?? "none"}`}</Text>
      {Object.entries(actions).map(([label, onPress]) => (
        <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} />
      ))}
    </>
  );
}

describe("the permission mode chosen for the chat on screen", () => {
  afterEach(cleanup);

  it("stays with a new chat once its first message makes it a chat", () => {
    render(<CanonicalChatSessionProvider><PermissionProbe /></CanonicalChatSessionProvider>);
    expect(screen.getByText("mode:none")).toBeTruthy();

    press("choose full access");
    press("bind chat");

    expect(screen.getByText("mode:full_access")).toBeTruthy();
  });

  it.each([
    ["starting a new chat", "new chat"],
    ["opening another chat", "open chat"],
  ])("is cleared by %s, which starts from its own mode", (_case, action) => {
    render(<CanonicalChatSessionProvider><PermissionProbe /></CanonicalChatSessionProvider>);
    press("choose full access");

    press(action);

    expect(screen.getByText("mode:none")).toBeTruthy();
  });
});

describe("the permission mode chosen on this phone", () => {
  beforeEach(() => {
    mockUserId = "user_a";
    mockComputer = COMPUTER_A;
  });
  afterEach(() => {
    cleanup();
    mockUserId = "user_a";
    mockComputer = undefined;
  });

  // The provider outlives sign-out, so a mode left on an unsent draft must not
  // reach the next account's first message, or another computer's.
  it.each([
    ["another account signs in on this phone", () => { mockUserId = "user_b"; }],
    ["the person signs out", () => { mockUserId = null; }],
    ["the person switches to another computer", () => { mockComputer = COMPUTER_B; }],
  ])("is not used after %s", (_case, change) => {
    const view = render(<CanonicalChatSessionProvider><PermissionProbe /></CanonicalChatSessionProvider>);
    press("choose full access");
    expect(screen.getByText("mode:full_access")).toBeTruthy();

    change();
    view.rerender(<CanonicalChatSessionProvider><PermissionProbe /></CanonicalChatSessionProvider>);

    expect(screen.getByText("mode:none")).toBeTruthy();
  });
});
