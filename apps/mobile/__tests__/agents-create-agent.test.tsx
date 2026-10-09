import { Fragment, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react-native";

import { CreationAttemptProvider } from "../components/agents/creation-attempt";
import { useCreateAgent } from "../components/agents/use-create-agent";

type Options = Parameters<typeof useCreateAgent>[0];

const inbox = { recipeId: "inbox-triage", version: "v1", name: "Inbox helper", description: "Summarize the inbox" };
const market = { recipeId: "competitor-watching", version: "v1", name: "Market helper", description: "Watch the market" };

type Created = { agentId: string; chatId: string };
const created = (name: string): Created => ({ agentId: `bot_${name}001`, chatId: `chat_${name}` });

// The new-agent screen inside the Agents tab. The provider outlives the screen
// under it, as the tab's layout does: `leaveAndReturn` is the screen left and
// opened again, with nothing of its own kept.
function openInAgentsTab(options: Options) {
  let visit = 0;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <CreationAttemptProvider>
      <Fragment key={visit}>{children}</Fragment>
    </CreationAttemptProvider>
  );
  const screen = renderHook(() => useCreateAgent(options), { wrapper });
  return {
    screen: screen.result,
    leaveAndReturn: () => {
      visit += 1;
      screen.rerender(undefined);
    },
  };
}

describe("creating an agent from a template", () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    warn.mockRestore();
  });

  it("sends the template, the trimmed name and no model, and reports the new agent and its chat", async () => {
    const create = jest.fn().mockResolvedValue(created("inbox"));
    const onCreated = jest.fn();
    const { result } = renderHook(() => useCreateAgent({ create, scope: "owner:gateway", onCreated }));

    await act(() => result.current.submit(inbox, "  Mail helper "));

    expect(create).toHaveBeenCalledWith(
      { recipeId: "inbox-triage", version: "v1" },
      expect.stringMatching(/^req_/),
      undefined,
      "Mail helper",
    );
    expect(onCreated).toHaveBeenCalledWith({ agentId: "bot_inbox001", chatId: "chat_inbox" });
    expect(result.current).toMatchObject({ creating: false, failed: false });
  });

  it("sends nothing for a blank name", async () => {
    const create = jest.fn();
    const { result } = renderHook(() => useCreateAgent({ create, scope: "owner:gateway", onCreated: jest.fn() }));

    await act(() => result.current.submit(inbox, "   "));

    expect(create).not.toHaveBeenCalled();
  });

  it("is creating until the server answers, and ignores a second submit meanwhile", async () => {
    let finish: (agent: Created) => void = () => {};
    const create = jest.fn().mockReturnValue(new Promise<Created>((resolve) => { finish = resolve; }));
    const onCreated = jest.fn();
    const { result } = renderHook(() => useCreateAgent({ create, scope: "owner:gateway", onCreated }));

    act(() => {
      void result.current.submit(inbox, "Inbox helper");
      void result.current.submit(inbox, "Inbox helper");
      void result.current.submit(market, "Market helper");
    });
    expect(result.current.creating).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();

    await act(async () => finish(created("inbox")));
    expect(result.current.creating).toBe(false);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("reports a failure without the server's words and can forget it", async () => {
    const create = jest.fn().mockRejectedValue(new Error("upstream said no"));
    const onCreated = jest.fn();
    const { result } = renderHook(() => useCreateAgent({ create, scope: "owner:gateway", onCreated }));

    await act(() => result.current.submit(inbox, "Inbox helper"));
    expect(result.current).toMatchObject({ creating: false, failed: true });
    expect(onCreated).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("upstream said no");

    act(() => result.current.clearFailure());
    expect(result.current.failed).toBe(false);
  });

  it("retries the same template and name under the same request id, and anything else under a new one", async () => {
    const create = jest.fn().mockRejectedValue(new Error("response lost"));
    const { result } = renderHook(() => useCreateAgent({ create, scope: "owner:gateway", onCreated: jest.fn() }));

    await act(() => result.current.submit(inbox, "Inbox helper"));
    await act(() => result.current.submit(inbox, " Inbox helper "));
    await act(() => result.current.submit(inbox, "Mail helper"));
    await act(() => result.current.submit(market, "Mail helper"));

    const ids = create.mock.calls.map((call) => call[1]);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[1]);
    expect(ids[3]).not.toBe(ids[2]);
  });

  it("starts afresh after a create the server confirmed", async () => {
    const create = jest.fn().mockResolvedValue(created("inbox"));
    const { result } = renderHook(() => useCreateAgent({ create, scope: "owner:gateway", onCreated: jest.fn() }));

    await act(() => result.current.submit(inbox, "Inbox helper"));
    await act(() => result.current.submit(inbox, "Inbox helper"));

    expect(create.mock.calls[1][1]).not.toBe(create.mock.calls[0][1]);
  });

  it("gives a retry in another account or on another computer its own request id", async () => {
    const create = jest.fn().mockRejectedValue(new Error("response lost"));
    const { result, rerender } = renderHook(
      ({ scope }: { scope: string }) => useCreateAgent({ create, scope, onCreated: jest.fn() }),
      { initialProps: { scope: "owner:gateway" } },
    );

    await act(() => result.current.submit(inbox, "Inbox helper"));
    rerender({ scope: "other:gateway" });
    await act(() => result.current.submit(inbox, "Inbox helper"));

    expect(create.mock.calls[1][1]).not.toBe(create.mock.calls[0][1]);
  });

  it("reuses the request id of a failed attempt after the screen is left and opened again", async () => {
    const create = jest.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce(created("inbox"));
    const onCreated = jest.fn();
    const { screen, leaveAndReturn } = openInAgentsTab({ create, scope: "owner:gateway", onCreated });
    await act(() => screen.current.submit(inbox, "Inbox helper"));
    expect(screen.current.failed).toBe(true);

    leaveAndReturn();
    expect(screen.current.failed).toBe(false);
    await act(() => screen.current.submit(inbox, "Inbox helper"));

    expect(onCreated).toHaveBeenCalledWith(created("inbox"));
    expect(create.mock.calls[1][1]).toBe(create.mock.calls[0][1]);
  });

  it("does not let an older create that finishes late erase a newer attempt's request id", async () => {
    let finishOlder: (agent: Created) => void = () => {};
    const create = jest.fn()
      .mockReturnValueOnce(new Promise<Created>((resolve) => { finishOlder = resolve; }))
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(created("newer"));
    const onCreated = jest.fn();
    const { screen, leaveAndReturn } = openInAgentsTab({ create, scope: "owner:gateway", onCreated });
    act(() => {
      void screen.current.submit(inbox, "Inbox helper");
    });

    leaveAndReturn();
    await act(() => screen.current.submit(market, "Market helper"));
    expect(screen.current.failed).toBe(true);
    const newerRequestId = create.mock.calls[1][1];

    await act(async () => finishOlder(created("older")));
    expect(onCreated).toHaveBeenCalledWith(created("older"));

    await act(() => screen.current.submit(market, "Market helper"));
    expect(onCreated).toHaveBeenLastCalledWith(created("newer"));
    expect(create.mock.calls[2][1]).toBe(newerRequestId);
  });
});
