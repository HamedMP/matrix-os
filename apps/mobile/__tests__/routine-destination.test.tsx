import type { RoutineDestinationView } from "@matrix-os/contracts/routine-destination";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { RoutineDestinationSection } from "../components/agents/RoutineDestinationSection";
import { requestRoutineDestination, RoutineDestinationRequestError } from "../lib/requests/routine-destination";
const mockAuth = { getToken: jest.fn(async () => "fixture-owner-token"), userId: "owner-a", sessionId: "session-a", isLoaded: true, isSignedIn: true };
jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => mockAuth }));
const EMPTY: RoutineDestinationView = { preference: { revision: 0, target: null, updatedAt: null }, availability: "unset" };
const selected = (chatId = "chat_current", revision = 1): RoutineDestinationView => ({ preference: { revision, target: { botId: "bot_research1", chatId, bindingCreatedAt: "2026-09-27T12:00:00.000Z" }, updatedAt: "2026-09-27T12:00:00.000Z" }, availability: "available" });
const response = (body: unknown, status = 200) => ({ ok: status === 200, status, json: async () => body } as Response);
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
afterEach(() => { cleanup(); jest.restoreAllMocks(); mockAuth.userId = "owner-a"; mockAuth.sessionId = "session-a"; mockAuth.getToken.mockReset().mockResolvedValue("fixture-owner-token"); });
const section = (chatId = "chat_current", gatewayUrl = "https://fixture.invalid/vm/a") => <RoutineDestinationSection botId="bot_research1" chatId={chatId} gatewayUrl={gatewayUrl} eligible/>;
it("native authenticated request sends only strict owner selection/CAS, validates reply and never changes permissions", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(response(selected()));
  const controller = new AbortController();
  expect(await requestRoutineDestination("fixture-token", "https://fixture.invalid/vm/a", "remember", { botId: "bot_research1", chatId: "chat_current", baseRevision: 0 }, controller.signal)).toEqual(selected());
  expect(String(fetchMock.mock.calls[0]![0])).toBe("https://fixture.invalid/vm/a/api/routine-cli/destination");
  const init = fetchMock.mock.calls[0]![1]!;
  expect(JSON.parse(init.body as string)).toEqual({ botId: "bot_research1", chatId: "chat_current", baseRevision: 0 });
  expect(init.headers).toMatchObject({ Authorization: "Bearer fixture-token" }); expect(init.signal).toBeDefined();
  await expect(requestRoutineDestination("fixture-token", "https://fixture.invalid", "remember", { botId: "bot_research1", chatId: "chat_current", baseRevision: 0, ownerId: "forged" })).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("native real section remembers once, reloads saved selection and clears with current CAS", async () => {
  let saved: RoutineDestinationView = EMPTY;
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
    if (init?.method === "POST") { const input = JSON.parse(init.body as string); expect(input.baseRevision).toBe(saved.preference.revision); saved = input.chatId ? selected() : { preference: { revision: 2, target: null, updatedAt: "2026-09-27T12:00:00.000Z" }, availability: "unset" }; }
    return response(saved);
  });
  const view = render(section()); await waitFor(() => expect(screen.getByRole("button", { name: "Use this Chat" }).props.accessibilityState.disabled).toBe(false));
  fireEvent.press(screen.getByRole("button", { name: "Use this Chat" })); await screen.findByText("This Chat is the routine destination on this Computer.");
  view.unmount(); render(section()); await screen.findByText("This Chat is the routine destination on this Computer.");
  expect(fetchMock.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
  fireEvent.press(screen.getByRole("button", { name: "Clear destination" })); await screen.findByText("No routine destination selected.");
  expect(fetchMock.mock.calls.filter(call => call[1]?.method === "POST")[1]![1]!.body).toBe(JSON.stringify({ baseRevision: 1 }));
});
it("native conflict refreshes current metadata without replay; generic write failure preserves selected view", async () => {
  let value = selected("chat_other", 4), fault = 409;
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => init?.method === "POST" ? response({ code: "revision_conflict", message: "/private/provider/path" }, fault) : response(value));
  render(section()); await waitFor(() => expect(screen.getByRole("button", { name: "Use this Chat" }).props.accessibilityState.disabled).toBe(false));
  value = selected("chat_newer", 5); fireEvent.press(screen.getByRole("button", { name: "Use this Chat" })); await screen.findByText(/destination changed elsewhere/);
  expect(fetchMock.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1); expect(screen.queryByText(/private\/provider/)).toBeNull();
  fault = 503; fireEvent.press(screen.getByRole("button", { name: "Use this Chat" })); await screen.findByText(/change could not be confirmed/);
  expect(screen.getByText("Another Bot Chat is the routine destination on this Computer.")).toBeTruthy(); expect(screen.getByRole("button", { name: "Use this Chat" }).props.accessibilityState.disabled).toBe(true);
});
it("native Chat/gateway switch aborts old load; late reply cannot replace current scoped state", async () => {
  const old = deferred<Response>(); let oldSignal: AbortSignal | undefined;
  jest.spyOn(global, "fetch").mockImplementation(async (url, init) => {
    if (String(url).includes("/vm/a/")) { oldSignal = init?.signal as AbortSignal; return old.promise; }
    return response(selected("chat_new", 8));
  });
  const view = render(section()); await waitFor(() => expect(oldSignal).toBeDefined());
  view.rerender(section("chat_new", "https://fixture.invalid/vm/b")); await screen.findByText("This Chat is the routine destination on this Computer."); expect(oldSignal!.aborted).toBe(true);
  await act(async () => old.resolve(response(EMPTY))); expect(screen.queryByText("No routine destination selected.")).toBeNull();
});
it("native owner switch while awaiting auth prevents dispatch under the wrong user", async () => {
  const token = deferred<string>(); mockAuth.getToken.mockImplementationOnce(() => token.promise);
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(response(EMPTY));
  const view = render(section()); await waitFor(() => expect(mockAuth.getToken).toHaveBeenCalled()); mockAuth.userId = "owner-b"; view.rerender(section());
  await screen.findByText("No routine destination selected."); await act(async () => token.resolve("old-owner-token"));
  expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({ Authorization: "Bearer fixture-owner-token" });
});
it("native request preserves known CAS status but suppresses malformed/network/provider details", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(response({ code: "revision_conflict" }, 409));
  await expect(requestRoutineDestination("fixture", "https://fixture.invalid", "reset", { baseRevision: 1 })).rejects.toMatchObject({ status: 409 });
  fetchMock.mockResolvedValue(response({ leaked: "/private/provider" }));
  await expect(requestRoutineDestination("fixture", "https://fixture.invalid", "get")).rejects.toEqual(new RoutineDestinationRequestError(null));
});

it("native same-owner auth session switch fences a stable getToken callback before HTTP dispatch", async () => {
  const token = deferred<string>(); mockAuth.getToken.mockImplementationOnce(() => token.promise);
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(response(EMPTY));
  const view = render(section()); await waitFor(() => expect(mockAuth.getToken).toHaveBeenCalledTimes(1));
  mockAuth.sessionId = "session-b"; view.rerender(section());
  await act(async () => token.resolve("old-session-token"));
  await screen.findByText("No routine destination selected.");
  expect(mockAuth.getToken).toHaveBeenCalledTimes(2); expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({ Authorization: "Bearer fixture-owner-token" });
});
