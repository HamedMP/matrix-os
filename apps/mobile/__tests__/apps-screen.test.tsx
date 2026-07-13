jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock("../app/_layout", () => ({
  useGateway: jest.fn(),
}));

jest.mock("expo-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock("@clerk/clerk-expo", () => ({
  useUser: () => ({ user: null }),
}));

jest.mock("expo-image", () => {
  const { View } = require("react-native");
  return {
    Image: (props: Record<string, unknown>) => {
      const mockReact = require("react");
      return mockReact.createElement(View, { testID: "expo-image", ...props });
    },
  };
});

import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import AppsScreen from "../app/(tabs)/apps";
import { useGateway } from "../app/_layout";
import { GatewayClient } from "../lib/gateway-client";
import { MOBILE_SHELL_STATE_STORAGE_KEY } from "../lib/mobile-shell-state";

const useGatewayMock = useGateway as jest.MockedFunction<typeof useGateway>;
type GatewayContextValue = ReturnType<typeof useGateway>;

function gatewayContext(overrides: Partial<GatewayContextValue>): GatewayContextValue {
  return {
    client: null,
    connectionState: "disconnected",
    gateway: null,
    setGateway: jest.fn(),
    unreadCount: 0,
    incrementUnread: jest.fn(),
    clearUnread: jest.fn(),
    ...overrides,
  };
}

describe("AppsScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    jest.mocked(AsyncStorage.setItem).mockResolvedValue();
  });

  it("keeps native Matrix apps visible before a gateway client is connected", async () => {
    useGatewayMock.mockReturnValue(gatewayContext({}));

    render(<AppsScreen />);

    await waitFor(() => expect(screen.getByText("Terminal")).toBeTruthy());
    // The mobile workspace slice keeps system surfaces visible in the grid,
    // except the current Apps launcher itself.
    expect(screen.queryByLabelText("Open Apps")).toBeNull();
    expect(screen.getByText("Tasks")).toBeTruthy();
    expect(screen.getByText("Settings")).toBeTruthy();
    // Chat is intentionally hidden from the launcher grid.
    expect(screen.queryByText("Chat")).toBeNull();
  });

  it("keeps native Matrix apps visible when the gateway returns no apps", async () => {
    const client = new GatewayClient("https://app.matrix-os.com");
    const getApps = jest.spyOn(client, "getApps").mockResolvedValue([]);
    useGatewayMock.mockReturnValue(gatewayContext({
      client,
      connectionState: "connected",
    }));

    render(<AppsScreen />);

    await waitFor(() => expect(getApps).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Terminal")).toBeTruthy());
    expect(screen.getByText("Tasks")).toBeTruthy();
    expect(screen.queryByText("Chat")).toBeNull();
  });

  it("keeps native Matrix apps visible when the gateway app fetch fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const client = new GatewayClient("https://app.matrix-os.com");
    const getApps = jest.spyOn(client, "getApps").mockRejectedValue(new Error("gateway unavailable"));
    useGatewayMock.mockReturnValue(gatewayContext({
      client,
      connectionState: "error",
    }));

    render(<AppsScreen />);

    await waitFor(() => expect(getApps).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Terminal")).toBeTruthy());
    expect(screen.getByText("Settings")).toBeTruthy();
    expect(screen.queryByText("Chat")).toBeNull();

    warn.mockRestore();
  });

  it("offers a real continue card for the last active app and updates persisted state when used", async () => {
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify({
      mode: "app",
      lastActiveAppSlug: "notes",
      updatedAt: "2026-05-13T00:00:00.000Z",
    }));
    const client = new GatewayClient("https://app.matrix-os.test");
    jest.spyOn(client, "getApps").mockResolvedValue([
      {
        name: "Notes",
        description: "Write and organize notes.",
        category: "Productivity",
        file: "notes/index.html",
        path: "/files/apps/notes/index.html",
        slug: "notes",
      },
    ]);
    useGatewayMock.mockReturnValue(gatewayContext({
      client,
      connectionState: "connected",
    }));

    render(<AppsScreen />);

    await waitFor(() => expect(screen.getByLabelText("Continue Notes")).toBeTruthy());
    fireEvent.press(screen.getByLabelText("Continue Notes"));

    await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      MOBILE_SHELL_STATE_STORAGE_KEY,
      expect.stringContaining("\"lastActiveAppSlug\":\"notes\""),
    ));
  });

  it("keeps the native Tasks app available in the continue card", async () => {
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify({
      mode: "app",
      lastActiveAppSlug: "tasks",
      updatedAt: "2026-05-13T00:00:00.000Z",
    }));
    useGatewayMock.mockReturnValue(gatewayContext({}));

    render(<AppsScreen />);

    await waitFor(() => expect(screen.getByLabelText("Continue Tasks")).toBeTruthy());
  });

  it("groups visible apps into main, my apps, and games sections", async () => {
    const client = new GatewayClient("https://app.matrix-os.test", "token");
    jest.spyOn(client, "getApps").mockResolvedValue([
      {
        name: "Notes",
        description: "Write and organize notes.",
        category: "Productivity",
        file: "notes/index.html",
        path: "/files/apps/notes/index.html",
        slug: "notes",
      },
      {
        name: "Snake",
        description: "Classic snake.",
        category: "Games",
        icon: "snake",
        file: "games/snake/index.html",
        path: "/files/apps/games/snake/index.html",
      },
    ]);
    useGatewayMock.mockReturnValue(gatewayContext({
      client,
      connectionState: "connected",
    }));

    render(<AppsScreen />);

    await waitFor(() => expect(screen.getByText("Main")).toBeTruthy());
    expect(screen.getByText("My Apps")).toBeTruthy();
    expect(screen.getByText("Games")).toBeTruthy();
    expect(screen.getByText("Notes")).toBeTruthy();
    expect(screen.getByText("Snake")).toBeTruthy();
  });

  it("loads gateway icons with the resolved bearer token and web shell extension logic", async () => {
    const client = new GatewayClient("https://app.matrix-os.test", () => Promise.resolve("fresh-token"));
    jest.spyOn(client, "getApps").mockResolvedValue([
      {
        name: "Game Center",
        description: "Browse games.",
        category: "Games",
        icon: "Game",
        file: "games/index.html",
        path: "/files/apps/games/index.html",
      },
      {
        name: "Pomodoro",
        description: "Focus timer.",
        category: "Productivity",
        icon: "pomodoro",
        file: "pomodoro/index.html",
        path: "/files/apps/pomodoro/index.html",
      },
    ]);
    useGatewayMock.mockReturnValue(gatewayContext({
      client,
      connectionState: "connected",
    }));

    render(<AppsScreen />);

    await waitFor(() => {
      const images = screen.getAllByTestId("expo-image");
      expect(images.some((node) =>
        node.props.source?.uri === "https://app.matrix-os.test/icons/game.svg" &&
        node.props.source?.headers?.Authorization === "Bearer fresh-token",
      )).toBe(true);
      expect(images.some((node) =>
        node.props.source?.uri === "https://app.matrix-os.test/icons/pomodoro-timer.png" &&
        node.props.source?.headers?.Authorization === "Bearer fresh-token",
      )).toBe(true);
    });
  });

  it("waits for an auth token before requesting authenticated gateway icons", async () => {
    let resolveToken!: (token: string) => void;
    const tokenPromise = new Promise<string>((resolve) => {
      resolveToken = resolve;
    });
    const client = new GatewayClient("https://app.matrix-os.test", () => tokenPromise);
    jest.spyOn(client, "getApps").mockResolvedValue([
      {
        name: "Snake",
        description: "Classic snake.",
        category: "Games",
        icon: "snake",
        file: "games/snake/index.html",
        path: "/files/apps/games/snake/index.html",
      },
    ]);
    useGatewayMock.mockReturnValue(gatewayContext({
      client,
      connectionState: "connected",
    }));

    render(<AppsScreen />);

    await waitFor(() => expect(screen.getByText("Snake")).toBeTruthy());
    expect(screen.queryAllByTestId("expo-image")).toHaveLength(0);

    await act(async () => {
      resolveToken("late-token");
      await tokenPromise;
    });

    await waitFor(() => {
      const image = screen.getAllByTestId("expo-image").find((node) =>
        node.props.source?.uri === "https://app.matrix-os.test/icons/snake.png",
      );
      expect(image?.props.source?.headers?.Authorization).toBe("Bearer late-token");
    });
  });
});
