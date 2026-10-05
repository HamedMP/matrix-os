import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, render, screen } from "@testing-library/react-native";

const mockReplace = jest.fn();
const mockFetchMobileJourney = jest.fn();
let mockHostedGateway = true;
let mockGatewayUrl = "https://example.test";
let mockSignedInUserId: string | null = "user_a";

jest.mock("expo-router", () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ isSignedIn: true, userId: "user_a", getToken: mockGetToken, signOut: jest.fn() }),
  getClerkInstance: () => ({ user: mockSignedInUserId ? { id: mockSignedInUserId } : null }),
}));
jest.mock("@/lib/storage", () => ({
  HOSTED_GATEWAY_URL: "https://example.test",
  getSelectedGatewayConnection: async () => ({ url: mockHostedGateway ? mockGatewayUrl : "http://10.0.0.2:4000" }),
  isHostedGatewayUrl: (url: string) => url.startsWith("https://example.test"),
  getMobileJourneyGatewayUrl: (url: string) => url,
}));
jest.mock("@/lib/journey", () => ({
  ...jest.requireActual("@/lib/journey"),
  fetchMobileJourney: (...args: unknown[]) => mockFetchMobileJourney(...args),
}));
jest.mock("@/components/auth/SignInScreen", () => ({ SignInScreen: () => null }));

import Index from "../app/index";
import { rememberJourneyConnectable, wasJourneyConnectable } from "../lib/journey-cache";

const mockGetToken = jest.fn(async () => "session-token");
const journey = (phase: string) => ({ status: "ok", journey: { phase, detail: "detail", nextAction: { kind: "wait" } } });

/** A journey request that stays in flight until the test settles it. */
function pendingJourney() {
  let settle!: (value: unknown) => void;
  mockFetchMobileJourney.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
  return (value: unknown) => act(async () => { settle(value); });
}

const flush = () => act(async () => { await new Promise((resolve) => setImmediate(resolve)); });

beforeEach(async () => {
  jest.clearAllMocks();
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

  expect(mockReplace).toHaveBeenCalledTimes(1);
  expect(await wasJourneyConnectable("user_a")).toBe(true);
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
  expect(screen.getByText("Choose your plan")).toBeTruthy();
  expect(await wasJourneyConnectable("user_a")).toBe(false);
});

it("enters a self-hosted computer without asking for a journey", async () => {
  mockHostedGateway = false;
  render(<Index />);
  await flush();

  expect(mockReplace).toHaveBeenCalledWith("/(drawer)");
  expect(mockFetchMobileJourney).not.toHaveBeenCalled();
});
