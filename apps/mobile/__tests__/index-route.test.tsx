let mockIsSignedIn = true;
const mockSignInScreen = jest.fn((_props?: unknown) => null);
let mockSearchParams: Record<string, unknown> = {};
const mockSetGateway = jest.fn();
const mockSetQueryData = jest.fn();
const mockCancelQueries = jest.fn(async () => undefined);
const mockQueryClient = {
  setQueryData: mockSetQueryData,
  cancelQueries: mockCancelQueries,
};
const mockFetchComputers = jest.fn();
const mockSavePrimary = jest.fn(async (computer) => ({
  url: "https://example.test" + computer.gatewayPath,
  runtimeSlot: "primary",
}));
jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => mockQueryClient,
}));
jest.mock("../app/_layout", () => ({
  useGateway: () => ({ setGateway: mockSetGateway }),
}));
jest.mock("@/lib/requests/computers", () => ({
  fetchComputers: (token: string) => mockFetchComputers(token),
}));
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, render, screen } from "@testing-library/react-native";

const mockReplace = jest.fn();
const mockFetchMobileJourney = jest.fn();
let mockHostedGateway = true;
let mockGatewayUrl = "https://example.test";
let mockSignedInUserId: string | null = "user_a";

const mockRouter = { replace: mockReplace };
jest.mock("expo-router", () => ({
  useLocalSearchParams: () => mockSearchParams,
  useRouter: () => mockRouter,
}));
jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({
    isSignedIn: mockIsSignedIn,
    userId: "user_a",
    getToken: mockGetToken,
    signOut: jest.fn(),
  }),
  getClerkInstance: () => ({
    user: mockSignedInUserId ? { id: mockSignedInUserId } : null,
  }),
}));
jest.mock("@/lib/storage", () => ({
  HOSTED_GATEWAY_URL: "https://example.test",
  saveSelectedHostedComputer: (computer: unknown) => mockSavePrimary(computer),
  getSelectedGatewayConnection: async () => ({
    url: mockHostedGateway ? mockGatewayUrl : "http://10.0.0.2:4000",
  }),
  isHostedGatewayUrl: (url: string) => url.startsWith("https://example.test"),
  getMobileJourneyGatewayUrl: (url: string) => url,
}));
jest.mock("@/lib/journey", () => ({
  ...jest.requireActual("@/lib/journey"),
  fetchMobileJourney: (...args: unknown[]) => mockFetchMobileJourney(...args),
}));
jest.mock("@/components/auth/SignInScreen", () => ({
  SignInScreen: (props: unknown) => mockSignInScreen(props),
}));

import Index from "../app/index";
import {
  rememberJourneyConnectable,
  wasJourneyConnectable,
} from "../lib/journey-cache";

const mockGetToken = jest.fn(async () => "session-token");
const journey = (phase: string) => ({
  status: "ok",
  journey: { phase, detail: "detail", nextAction: { kind: "wait" } },
});

/** A journey request that stays in flight until the test settles it. */
function pendingJourney() {
  let settle!: (value: unknown) => void;
  mockFetchMobileJourney.mockReturnValue(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  return (value: unknown) =>
    act(async () => {
      settle(value);
    });
}

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });

beforeEach(async () => {
  jest.clearAllMocks();
  mockSearchParams = {};
  mockIsSignedIn = true;
  mockHostedGateway = true;
  mockGatewayUrl = "https://example.test";
  mockSignedInUserId = "user_a";
  await AsyncStorage.clear();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

it("holds the gate until the journey answers when nothing is remembered", async () => {
  const settle = pendingJourney();
  render(<Index />);
  await flush();

  expect(mockReplace).not.toHaveBeenCalled();
  expect(screen.getByTestId("journey-loading")).toBeTruthy();

  await settle(journey("ready"));
  expect(mockReplace).toHaveBeenCalledWith("/(drawer)");
  expect(await wasJourneyConnectable("user_a")).toBe(true);
});

it("opens the shell on a remembered answer without waiting for the journey", async () => {
  await rememberJourneyConnectable("user_a");
  const settle = pendingJourney();
  render(<Index />);
  await flush();

  expect(mockReplace).toHaveBeenCalledTimes(1);
  expect(mockReplace).toHaveBeenCalledWith("/(drawer)");

  await settle(journey("ready"));
  expect(mockReplace).toHaveBeenCalledTimes(1);
});

it("does not use an answer remembered for someone else", async () => {
  await rememberJourneyConnectable("user_b");
  pendingJourney();
  render(<Index />);
  await flush();

  expect(mockReplace).not.toHaveBeenCalled();
});

it("comes back to the gate when the remembered computer is no longer connectable", async () => {
  await rememberJourneyConnectable("user_a");
  const settle = pendingJourney();
  const view = render(<Index />);
  await flush();
  // The shell has replaced this screen by the time the journey answers.
  view.unmount();

  await settle(journey("plan_required"));

  expect(mockReplace).toHaveBeenLastCalledWith("/");
  expect(await wasJourneyConnectable("user_a")).toBe(false);
});

it("comes back to the gate when the session is no longer accepted", async () => {
  await rememberJourneyConnectable("user_a");
  const settle = pendingJourney();
  render(<Index />);
  await flush();

  await settle({ status: "unauthorized" });

  expect(mockReplace).toHaveBeenLastCalledWith("/");
  expect(await wasJourneyConnectable("user_a")).toBe(false);
});

it("ignores a late answer once someone else is signed in", async () => {
  await rememberJourneyConnectable("user_a");
  const settle = pendingJourney();
  render(<Index />);
  await flush();
  mockSignedInUserId = "user_b";
  await rememberJourneyConnectable("user_b");

  await settle(journey("plan_required"));

  expect(mockReplace).toHaveBeenCalledTimes(1);
  expect(await wasJourneyConnectable("user_b")).toBe(true);
});

it("does not remember a late ready answer for a user who is no longer signed in", async () => {
  await rememberJourneyConnectable("user_a");
  const settle = pendingJourney();
  render(<Index />);
  await flush();
  mockSignedInUserId = "user_b";
  await rememberJourneyConnectable("user_b");

  await settle(journey("ready"));

  expect(await wasJourneyConnectable("user_b")).toBe(true);
});

it("ignores a late answer once another computer is selected", async () => {
  await rememberJourneyConnectable("user_a");
  const settle = pendingJourney();
  render(<Index />);
  await flush();
  mockGatewayUrl = "https://example.test/vm/other";

  await settle(journey("plan_required"));

  // The answer is still true of the account, so the next launch asks again;
  // it just does not pull the user out of the computer they have since chosen.
  expect(mockReplace).toHaveBeenCalledTimes(1);
  expect(await wasJourneyConnectable("user_a")).toBe(false);
});

it("stays in the shell on a remembered answer when the journey cannot be reached", async () => {
  await rememberJourneyConnectable("user_a");
  const settle = pendingJourney();
  render(<Index />);
  await flush();

  await settle({ status: "unreachable" });

  expect(mockReplace).toHaveBeenCalledTimes(1);
  expect(await wasJourneyConnectable("user_a")).toBe(true);
});

it("shows the onboarding phase when the computer is not ready and nothing is remembered", async () => {
  mockFetchMobileJourney.mockResolvedValue(journey("plan_required"));
  render(<Index />);
  await flush();

  expect(mockReplace).not.toHaveBeenCalled();
  // The gate's own screen for that phase, whatever its wording.
  expect(screen.getByTestId("journey-refresh")).toBeTruthy();
  expect(screen.queryByTestId("journey-loading")).toBeNull();
  expect(await wasJourneyConnectable("user_a")).toBe(false);
});

it("enters a self-hosted computer without asking for a journey", async () => {
  mockHostedGateway = false;
  render(<Index />);
  await flush();

  expect(mockReplace).toHaveBeenCalledWith("/(drawer)");
  expect(mockFetchMobileJourney).not.toHaveBeenCalled();
});

it("selects the verified main computer before opening a WhatsApp Chat", async () => {
  mockSearchParams = { chat: "chat_12345678" };
  const main = {
    handle: "main",
    runtimeSlot: "primary",
    kind: "customer",
    availability: "available",
    gatewayPath: "/vm/main",
  };
  mockFetchComputers.mockResolvedValue({
    items: [{ ...main, runtimeSlot: "preview" }, main],
  });
  mockFetchMobileJourney.mockResolvedValue(journey("ready"));
  render(<Index />);
  await flush();
  await flush();
  expect(mockSavePrimary).toHaveBeenCalledWith(main);
  expect(mockSetGateway).toHaveBeenCalledWith(
    expect.objectContaining({ runtimeSlot: "primary" }),
  );
  expect(mockSetQueryData).toHaveBeenCalledWith(expect.any(Array), main);
  expect(mockReplace).toHaveBeenCalledWith({
    pathname: "/(drawer)",
    params: { chat: "chat_12345678" },
  });
});
it("keeps the handoff at a retryable gate when no main computer is available", async () => {
  mockSearchParams = { chat: "chat_12345678" };
  mockFetchComputers.mockResolvedValue({ items: [] });
  render(<Index />);
  await flush();
  expect(mockReplace).not.toHaveBeenCalled();
  expect(mockSavePrimary).not.toHaveBeenCalled();
  expect(screen.getByTestId("journey-retry")).toBeTruthy();
});

it("requires Matrix account sign-in for a WhatsApp link instead of opening saved self-hosted credentials", async () => {
  mockIsSignedIn = false;
  mockHostedGateway = false;
  mockSearchParams = { chat: "chat_12345678" };
  render(<Index />);
  await flush();
  expect(mockReplace).not.toHaveBeenCalled();
  expect(mockSignInScreen).toHaveBeenCalledWith(
    expect.objectContaining({ requestedChat: "chat_12345678" }),
  );
});
