// GatewayShell does not exercise Markdown rendering. Keep this focused React
// Native Jest suite from loading the ESM-only micromark implementation
// re-exported by the shared contracts package.
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

type GatewayContext = ReturnType<typeof import("../app/_layout").useGateway>;

const mockUseAuth = jest.fn();
const mockGetSelectedGatewayConnection = jest.fn();
let mockGatewayContext: GatewayContext | null = null;

jest.mock("expo-router", () => {
  // The Stack is rendered inside the gateway provider, so it doubles as the
  // probe that captures what screens receive from useGateway().
  function Stack() {
    mockGatewayContext = require("../app/_layout").useGateway();
    return null;
  }
  Stack.Screen = () => null;
  return {
    Stack,
    useRouter: () => ({ navigate: jest.fn() }),
    usePathname: () => "/",
  };
});

jest.mock("@clerk/clerk-expo", () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => mockUseAuth(),
}));

jest.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve(true)),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock("@expo-google-fonts/inter", () => ({ useFonts: () => [true] }));
jest.mock("@expo-google-fonts/jetbrains-mono", () => ({}));
jest.mock("@expo-google-fonts/bricolage-grotesque", () => ({}));
jest.mock("@expo-google-fonts/geist", () => ({}));

jest.mock("react-native-gesture-handler", () => {
  const { View } = require("react-native");
  return { GestureHandlerRootView: View };
});

jest.mock("@/lib/canonical-chat-session-context", () => ({
  CanonicalChatSessionProvider: ({ children }: { children: ReactNode }) => children,
}));

jest.mock("@/lib/storage", () => ({
  ...jest.requireActual("@/lib/storage"),
  getSelectedGatewayConnection: () => mockGetSelectedGatewayConnection(),
}));

jest.mock("@/lib/auth", () => ({
  authenticateBiometric: jest.fn(() => Promise.resolve(true)),
}));

jest.mock("@/lib/push", () => ({
  addNotificationResponseListener: jest.fn(() => ({ remove: jest.fn() })),
  handleNotificationTap: jest.fn(),
}));

jest.mock("@/lib/theme-preference", () => ({
  startMobileThemeController: () => () => {},
}));

jest.mock("@/lib/analytics", () => ({
  captureScreen: jest.fn(),
  getAnalyticsClient: () => null,
  identifyUser: jest.fn(),
  sanitizeScreenName: (name: string) => name,
}));

import React, { type ReactNode } from "react";
import { act, render, waitFor } from "@testing-library/react-native";

import { GatewayClient } from "../lib/gateway-client";
import { HOSTED_GATEWAY, type GatewayConnection } from "../lib/storage";
import { MobileTerminalClient } from "../lib/terminal-client";
import { jsonResponse } from "./mobile-shell-test-utils";

const SELF_HOSTED_GATEWAY: GatewayConnection = {
  id: "matrix-os-custom",
  url: "https://matrix.example.com",
  token: "Basic bWF0cml4OnNlY3JldA==",
  name: "Self-hosted",
  addedAt: 1,
};
const TERMINAL_SESSION_ID = "tws_00000000000000000000000000000001:tt_00000000000000000000000000000001";
const WS_TOKEN_PATH = "/api/auth/ws-token";

const openedSocketUrls: string[] = [];

class RecordingWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = RecordingWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    openedSocketUrls.push(url);
  }

  send() {}

  close() {
    this.readyState = RecordingWebSocket.CLOSED;
  }
}

function signedInAuth() {
  const auth = {
    isLoaded: true,
    isSignedIn: true,
    userId: "user_123",
    getToken: jest.fn(async () => "clerk-token"),
  };
  mockUseAuth.mockReturnValue(auth);
}

function signedOutAuth() {
  const auth = {
    isLoaded: true,
    isSignedIn: false,
    userId: null,
    getToken: jest.fn(async () => null),
  };
  mockUseAuth.mockReturnValue(auth);
}

function loadRootLayout() {
  // The publishable key is read once at module load, so set it before the
  // first require of the layout.
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_gateway_shell";
  return (require("../app/_layout") as typeof import("../app/_layout")).default;
}

/** Drains the mount/switch async chain (storage read, Clerk token, client setup). */
async function settle() {
  for (let turn = 0; turn < 5; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderShell(): Promise<GatewayClient> {
  const RootLayout = loadRootLayout();
  render(<RootLayout />);
  await waitFor(() => expect(mockGatewayContext?.client).toBeInstanceOf(GatewayClient));
  await settle();
  return mockGatewayContext!.client!;
}

describe("GatewayShell", () => {
  const OriginalWebSocket = global.WebSocket;
  let fetchMock: jest.SpyInstance<ReturnType<typeof fetch>, Parameters<typeof fetch>>;

  function fetchedPaths(): string[] {
    return fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
  }

  beforeEach(() => {
    mockGatewayContext = null;
    openedSocketUrls.length = 0;
    global.WebSocket = RecordingWebSocket as unknown as typeof WebSocket;
    fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (input) =>
      jsonResponse(
        new URL(String(input)).pathname === WS_TOKEN_PATH
          ? { token: "ws-token", expiresAt: Date.now() + 300_000 }
          : {},
      ));
  });

  afterEach(() => {
    global.WebSocket = OriginalWebSocket;
    jest.restoreAllMocks();
  });

  it("gives a signed-in hosted computer a gateway client without opening the legacy chat socket", async () => {
    signedInAuth();
    mockGetSelectedGatewayConnection.mockResolvedValue(HOSTED_GATEWAY);

    const client = await renderShell();

    expect(client.httpUrl).toBe("https://app.matrix-os.com");
    expect(mockGatewayContext?.gateway?.url).toBe("https://app.matrix-os.com");
    expect(openedSocketUrls).toEqual([]);
    expect(fetchedPaths()).not.toContain(WS_TOKEN_PATH);
  });

  it("gives saved self-hosted credentials a gateway client without opening the legacy chat socket", async () => {
    signedOutAuth();
    mockGetSelectedGatewayConnection.mockResolvedValue(SELF_HOSTED_GATEWAY);

    const client = await renderShell();

    expect(client.httpUrl).toBe("https://matrix.example.com");
    expect(openedSocketUrls).toEqual([]);
    expect(fetchedPaths()).not.toContain(WS_TOKEN_PATH);
  });

  it("switches computers without opening the legacy chat socket", async () => {
    signedInAuth();
    mockGetSelectedGatewayConnection.mockResolvedValue(HOSTED_GATEWAY);
    const hostedClient = await renderShell();

    act(() => {
      mockGatewayContext!.setGateway(SELF_HOSTED_GATEWAY);
    });
    await settle();

    const switchedClient = mockGatewayContext!.client!;
    expect(switchedClient).not.toBe(hostedClient);
    expect(switchedClient.httpUrl).toBe("https://matrix.example.com");
    expect(mockGatewayContext?.gateway).toEqual(SELF_HOSTED_GATEWAY);
    expect(openedSocketUrls).toEqual([]);
    expect(fetchedPaths()).not.toContain(WS_TOKEN_PATH);
  });

  it("still mints a ws-token on demand for the terminal socket", async () => {
    signedInAuth();
    mockGetSelectedGatewayConnection.mockResolvedValue(HOSTED_GATEWAY);
    const client = await renderShell();

    const connection = await new MobileTerminalClient(client).connect({
      sessionId: TERMINAL_SESSION_ID,
      onMessage: jest.fn(),
    });

    expect(fetchedPaths().filter((path) => path === WS_TOKEN_PATH)).toHaveLength(1);
    expect(openedSocketUrls).toHaveLength(1);
    const terminalUrl = new URL(openedSocketUrls[0]!);
    expect(`${terminalUrl.origin}${terminalUrl.pathname}`).toBe("wss://app.matrix-os.com/ws/terminal/tab");
    expect(terminalUrl.searchParams.get("token")).toBe("ws-token");
    connection?.close();
  });
});
