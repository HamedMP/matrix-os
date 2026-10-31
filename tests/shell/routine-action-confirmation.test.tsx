// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { RoutineActionConfirmation, RoutineActionInbox } from "../../packages/ui/src/routine-action/RoutineActionConfirmation";
import { useRoutineAction } from "../../packages/ui/src/routine-action/use-routine-action";
import { createRoutineActionBrowserClient } from "../../packages/ui/src/routine-action/client";
import { routineActionConfirmationUrl } from "@matrix-os/contracts";
const id = `rcact_${"a".repeat(32)}`;
const view = { challengeId: id, actionDigest: "d".repeat(64), sourceKind: "terminal_launch" as const, operation: "pause" as const,
  intent: { operation: "pause", requestId: "de000000-0000-4000-8000-000000000001", routineId: `rt_${"b".repeat(24)}`, baseRevision: 3 },
  target: { botId: "bot_target", chatId: "chat_target" }, sourceLabel: "Terminal terminal_one",
  expiresAt: new Date(Date.now() + 120_000).toISOString(), status: "pending" as const, title: "Allow routine pause?",
  description: "Allow this operation only. Routine activation, background model consent and integration permissions remain separate." as const };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("shows the exact operation and pinned destination; read/mount never decides", async () => {
  const submit = vi.fn(), client = { read: async () => view, list: async () => [view], submit };
  render(<RoutineActionConfirmation client={client as never} challengeId={id} identity="owner-a"/>);
  await screen.findByText("Allow routine pause?");
  expect(screen.getByText(/rt_bbbbbbbbbbbbbbbbbbbbbbbb/)).toBeTruthy();
  expect(screen.getByText(/chat_target/)).toBeTruthy();
  expect(submit).not.toHaveBeenCalled(); expect(screen.queryByText("Approve for session")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit).toHaveBeenCalledWith(id, { decision: "approve", actionDigest: view.actionDigest, clientRequestId: expect.any(String) }, expect.any(AbortSignal));
});
it("device-only Electron opens/reopens the browser without submitting or claiming approval", async () => {
  const submit = vi.fn(), open = vi.fn(async () => {}), client = { read: async () => view, list: async () => [view], submit };
  render(<RoutineActionConfirmation client={client as never} challengeId={id} identity="native-owner" openConfirmation={open}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Confirm in browser" }));
  await screen.findByRole("button", { name: "Reopen owner confirmation" });
  expect(open).toHaveBeenCalledWith(id, expect.any(AbortSignal)); expect(submit).not.toHaveBeenCalled();
  expect(screen.getByText("Awaiting your decision")).toBeTruthy(); expect(screen.queryByText("This operation was allowed")).toBeNull();
});
it("aborts old owner/Computer/session work, preventing late state and token-wait sends", async () => {
  let release!: (value: typeof view) => void; const old = new Promise<typeof view>(resolve => { release = resolve; });
  const reads: AbortSignal[] = [], client = { read: async (_id: string, signal: AbortSignal) => { reads.push(signal); return old; }, list: async () => [], submit: vi.fn() };
  const mounted = render(<RoutineActionConfirmation client={client as never} challengeId={id} identity="owner-a"/>);
  mounted.rerender(<RoutineActionConfirmation client={{ ...client, read: async () => ({ ...view, title: "Owner B action" }) } as never} challengeId={id} identity="owner-b"/>);
  await screen.findByText("Owner B action"); expect(reads[0]?.aborted).toBe(true);
  await act(async () => { release(view); await old; }); expect(screen.queryByText("Allow routine pause?")).toBeNull();
});
it("pins HTTPS app origin, explicit Computer/runtime and opaque challenge selectors", () => {
  expect(routineActionConfirmationUrl("https://app.example.test", "/vm/owner-pc?runtime=preview-one", id)).toBe(`https://app.example.test/vm/owner-pc/routine-cli/confirm?runtime=preview-one&challenge=${id}`);
  for (const path of ["https://evil.example/vm/owner-pc", "https://app.example.test/vm/owner-pc", "//app.example.test/vm/owner-pc", "/vm/ignored/../owner-pc", "/vm/%6fwner-pc", "/", "/vm/owner-pc?token=secret", "/vm/owner-pc#approve", "/vm/owner-pc?runtime=one&runtime=two"])
    expect(() => routineActionConfirmationUrl("https://app.example.test", path, id)).toThrow();
});
it("a failed current challenge read disables decisions without falsely recording expiry", async () => {
  vi.useFakeTimers(); let fail = false;
  const client = { read: async () => { if (fail) throw new Error("Fixture unavailable"); return view; }, list: async () => [], submit: vi.fn() };
  try {
    render(<RoutineActionConfirmation client={client as never} challengeId={id} identity="owner-a"/>);
    await act(async () => {}); expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
    fail = true; await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(screen.getByText("This request is unavailable")).toBeTruthy(); expect(screen.queryByText("This request expired")).toBeNull();
  } finally { vi.useRealTimers(); }
});

it("the shared Terminal inbox waits for a real current read before claiming it is empty", async () => {
  let release!: () => void; const pending = new Promise<never[]>(resolve => { release = () => resolve([]); });
  const client = { read: async () => view, list: async () => pending, submit: vi.fn() };
  render(<RoutineActionInbox client={client as never} identity="owner-a"/>);
  const details = screen.getByText("Routine confirmations").closest("details")!; details.open = true;
  fireEvent(details, new Event("toggle"));
  expect(screen.queryByText("No pending routine confirmations on this Computer.")).toBeNull();
  expect(screen.getByText("Loading confirmations…")).toBeTruthy();
  await act(async () => { release(); await pending; });
  expect(screen.getByText("No pending routine confirmations on this Computer.")).toBeTruthy();
});

it.each(["owner-b:session-a:computer-a", "owner-a:session-b:computer-a", "owner-a:session-a:computer-b"])("rejects a retained decision callback after scope changes to %s", async identity => {
  const submit = vi.fn(), openConfirmation = vi.fn(async () => {});
  const client = { read: async () => view, list: async () => [view], submit };
  const hook = renderHook(({ identity }) => useRoutineAction({ client: client as never, challengeId: id, identity }),
    { initialProps: { identity: "owner-a:session-a:computer-a" } });
  await waitFor(() => expect(hook.result.current.active).toBe(true));
  const oldSubmit = hook.result.current.submit;
  hook.rerender({ identity });
  await waitFor(() => expect(hook.result.current.active).toBe(true));
  await act(async () => { await oldSubmit("approve"); });
  expect(submit).not.toHaveBeenCalled();
  await act(async () => { await hook.result.current.submit("approve"); });
  expect(submit).toHaveBeenCalledTimes(1);
  hook.unmount();
  const browserHook = renderHook(({ identity }) => useRoutineAction({ client: client as never, challengeId: id, identity, openConfirmation }),
    { initialProps: { identity: "owner-a:session-a:computer-a" } });
  await waitFor(() => expect(browserHook.result.current.active).toBe(true));
  const oldOpen = browserHook.result.current.submit;
  browserHook.rerender({ identity });
  await waitFor(() => expect(browserHook.result.current.active).toBe(true));
  await act(async () => { await oldOpen("approve"); });
  expect(openConfirmation).not.toHaveBeenCalled();
});

it("does not send a decision waiting on stable getToken after same-owner session change or unmount", async () => {
  let resolveToken!: (token: string) => void;
  let delayToken = false;
  const getToken = vi.fn(() => delayToken ? new Promise<string>(resolve => { resolveToken = resolve; }) : Promise.resolve("fixture-token"));
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => new Response(JSON.stringify(init?.method === "POST" ? { submission: "accepted" } : view)));
  const client = createRoutineActionBrowserClient("https://app.example.test/vm/owner-pc", getToken, fetcher as typeof fetch);
  const hook = renderHook(({ identity }) => useRoutineAction({ client, challengeId: id, identity }), { initialProps: { identity: "owner-a:session-a" } });
  await waitFor(() => expect(hook.result.current.active).toBe(true));
  delayToken = true;
  let pending!: Promise<void>;
  act(() => { pending = hook.result.current.submit("approve"); });
  const oldResolve = resolveToken;
  delayToken = false;
  hook.rerender({ identity: "owner-a:session-b" });
  await act(async () => { oldResolve("fixture-new-session-token"); await pending; });
  await waitFor(() => expect(hook.result.current.active).toBe(true));
  delayToken = true;
  act(() => { pending = hook.result.current.submit("approve"); });
  hook.unmount();
  await act(async () => { resolveToken("fixture-new-session-token"); await pending; });
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
});

it("rejects retained callbacks after unmount and after the displayed challenge loses freshness", async () => {
  vi.useFakeTimers(); let fail = false;
  const submit = vi.fn(), client = { read: async () => { if (fail) throw new Error("Fixture read unavailable"); return view; }, list: async () => [], submit };
  try {
    const hook = renderHook(() => useRoutineAction({ client: client as never, challengeId: id, identity: "owner-a" }));
    await act(async () => {});
    const oldSubmit = hook.result.current.submit;
    fail = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(hook.result.current.active).toBe(false);
    await act(async () => { await oldSubmit("approve"); });
    expect(submit).not.toHaveBeenCalled();
    hook.unmount();
    await act(async () => { await oldSubmit("approve"); });
    expect(submit).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it("settles an aborted token wait promptly even when Clerk never resolves", async () => {
  const fetcher = vi.fn(), client = createRoutineActionBrowserClient("https://app.example.test/vm/owner-pc", () => new Promise(() => {}), fetcher);
  const abort = new AbortController(); let settled = false;
  const pending = client.read(id, abort.signal).catch(() => { settled = true; });
  abort.abort();
  await act(async () => { await Promise.resolve(); });
  expect(settled).toBe(true); expect(fetcher).not.toHaveBeenCalled();
  await pending;
});

it("times out a nonsettling token provider without sending or retaining a timer", async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn(), client = createRoutineActionBrowserClient("https://app.example.test/vm/owner-pc", () => new Promise(() => {}), fetcher);
    let rejected = false;
    const pending = client.read(id, new AbortController().signal).catch(() => { rejected = true; });
    await vi.advanceTimersByTimeAsync(10_000); await pending;
    expect(rejected).toBe(true); expect(fetcher).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
