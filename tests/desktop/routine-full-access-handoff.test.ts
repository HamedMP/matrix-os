import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown>, invoke: vi.fn() }));
vi.mock("../../desktop/src/renderer/src/stores/connection", () => ({ useConnection: { getState: () => mocks.state } }));
vi.mock("../../desktop/src/renderer/src/lib/operator", () => ({ invoke: mocks.invoke }));
import { openDesktopRoutineFullAccess } from "../../desktop/src/renderer/src/features/chat/routine-full-access";
afterEach(() => vi.resetAllMocks());
const status = { revision: 0, eligibility: "eligible", origin: "browser_required", consent: null, challenge: null };
function setup(get = vi.fn(async () => status)) {
  const post = vi.fn(), api = { get, post, forRuntime: vi.fn(() => api) };
  mocks.state = { status: "signed-in", api, platformHost: "https://app.example.test", runtimeSlot: "review1", userId: "owner", authGeneration: 3 };
  mocks.invoke.mockImplementation(async (channel: string) => channel === "runtime:list-computers" ? { items: [{ handle: "dev-pc", runtimeSlot: "review1", label: "Additional Computer", availability: "available",
    kind: "customer", gatewayPath: "/vm/dev-pc?runtime=review1", capabilities: [] }], hasMore: false, limit: 20, selectedSlot: "review1" } : undefined);
  return { get, post };
}
it("uses the actual selected descriptor and opens only the owner page without submitting consent", async () => {
  const { get, post } = setup(); await openDesktopRoutineFullAccess("chat_source");
  expect(get).toHaveBeenCalledWith("/vm/dev-pc/~runtime/review1/api/chats/chat_source/routine-cli/full-access", expect.any(Object));
  expect(mocks.invoke).toHaveBeenLastCalledWith("shell:open-external", { url: "https://app.example.test/vm/dev-pc/routine-cli/full-access?runtime=review1&chat=chat_source" });
  expect(post).not.toHaveBeenCalled();
});
it("does not open a stale owner/Computer callback after descriptor lookup", async () => {
  const { get } = setup();
  mocks.invoke.mockImplementation(async () => { mocks.state = { ...mocks.state, authGeneration: 4 }; return { items: [], hasMore: false, limit: 20, selectedSlot: null }; });
  await expect(openDesktopRoutineFullAccess("chat_source")).rejects.toThrow();
  expect(get).not.toHaveBeenCalled(); expect(mocks.invoke).toHaveBeenCalledTimes(1);
});
it("does not open after its owning Chat aborts during the status read", async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const get = vi.fn(async () => { await waiting; return status; }); setup(get);
  const abort = new AbortController(), opening = openDesktopRoutineFullAccess("chat_source", abort.signal);
  const rejected = expect(opening).rejects.toThrow();
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1)); abort.abort(); release(); await rejected;
  expect(mocks.invoke.mock.calls.filter(([channel]) => channel === "shell:open-external")).toHaveLength(0);
});
