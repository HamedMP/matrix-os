// @vitest-environment jsdom
import React, { useState } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RoutineFullAccessStatusSchema, type RoutineFullAccessStatus } from "@matrix-os/contracts";
import { useRoutineFullAccess } from "../../packages/ui/src/routine-action/use-routine-full-access";
import { RoutineFullAccessConsentContent } from "../../packages/ui/src/routine-action/RoutineFullAccessConsent";
import type { RoutineFullAccessClient } from "../../packages/ui/src/routine-action/full-access-client";

const empty = RoutineFullAccessStatusSchema.parse({ revision: 0, eligibility: "eligible", origin: "browser_required", consent: null, challenge: null });
const challenge = { challengeId: `rcfull_${"a".repeat(32)}`, scopeDigest: "d".repeat(64), expiresAt: new Date(Date.now() + 300_000).toISOString(), policyRevision: 0,
  actions: ["read", "propose", "control"] as ["read", "propose", "control"], target: { botId: "bot_fixture1", chatId: "chat_destination" } };
const pending = { ...empty, challenge };
const allowed = RoutineFullAccessStatusSchema.parse({ ...empty, revision: 1, consent: { scopeId: challenge.challengeId, expiresAt: challenge.expiresAt,
  policyRevision: challenge.policyRevision, actions: challenge.actions, target: challenge.target } });
function client() {
  let value: RoutineFullAccessStatus = empty;
  return { read: vi.fn(async () => value), challenge: vi.fn(async () => value = pending),
    decide: vi.fn(async (_chatId, _id, input) => value = input.decision === "approve" ? allowed : { ...empty, revision: 1 }),
    revoke: vi.fn(async () => value = { ...empty, revision: 2 }) } satisfies RoutineFullAccessClient;
}
function Harness({ api, browserOrigin = true, identity = "owner-a", chatId = "chat_source", enabled = true, openOwnerBrowser }: {
  api: RoutineFullAccessClient; browserOrigin?: boolean; identity?: string; chatId?: string; enabled?: boolean; openOwnerBrowser?: () => Promise<void>;
}) {
  const [mode, setMode] = useState("supervised");
  const controller = useRoutineFullAccess({ client: api, chatId, identity, enabled, browserOrigin, openOwnerBrowser,
    permissionMode: mode, onPermissionModeChange: setMode });
  return <><output>{mode}</output><button onClick={() => controller.changeMode("full_access")}>Select Full Access</button>
    <button onClick={() => controller.changeMode("supervised")}>Select Supervised</button>
    {controller.visible ? <RoutineFullAccessConsentContent controller={controller}/> : null}</>;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("selection and mount grant nothing; the explicit owner decision uses only the server challenge", async () => {
  const api = client(); render(<Harness api={api}/>);
  await waitFor(() => expect(api.read).toHaveBeenCalledTimes(1));
  expect(api.challenge).not.toHaveBeenCalled(); expect(api.decide).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Select Full Access" }));
  const allow = await screen.findByRole("button", { name: "Allow routine CLI in this private Chat" });
  expect(screen.getByText("bot_fixture1")).toBeTruthy(); expect(screen.getByText("chat_destination")).toBeTruthy();
  expect(screen.getByText(/Schedule activation, background model consent and integration permissions remain separate/)).toBeTruthy();
  expect(api.decide).not.toHaveBeenCalled();
  fireEvent.click(allow);
  await screen.findByText(/This scope applies to new verified browser turns/);
  expect(api.decide).toHaveBeenCalledWith("chat_source", challenge.challengeId,
    { scopeDigest: challenge.scopeDigest, decision: "approve", clientRequestId: expect.any(String) }, expect.any(AbortSignal));
});

it("does not turn an unavailable verifier into a healthy status, but allows explicit fresh proof retry", async () => {
  const api = client(); api.read.mockResolvedValue({ ...empty, eligibility: "unavailable" });
  api.challenge.mockResolvedValue({ ...pending, eligibility: "unavailable" });
  render(<Harness api={api}/>);
  fireEvent.click(screen.getByRole("button", { name: "Select Full Access" }));
  fireEvent.click(await screen.findByRole("button", { name: "Allow routine CLI in this private Chat" }));
  await waitFor(() => expect(api.decide).toHaveBeenCalledTimes(1));
  expect(api.challenge).toHaveBeenCalledTimes(1);
});

it.each(["owner-b", "same-owner-new-session", "same-owner-new-computer", "chat_source_b"])("fences pending challenge work when scope changes to %s", async identity => {
  const api = client(); let release!: (value: RoutineFullAccessStatus) => void;
  api.challenge.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const mounted = render(<Harness api={api}/>);
  fireEvent.click(screen.getByRole("button", { name: "Select Full Access" }));
  await waitFor(() => expect(api.challenge).toHaveBeenCalledTimes(1));
  mounted.rerender(<Harness api={api} identity={identity} chatId={identity === "chat_source_b" ? identity : "chat_source"}/>);
  await act(async () => { release(pending); });
  expect(screen.queryByRole("button", { name: "Allow routine CLI in this private Chat" })).toBeNull();
  expect(api.decide).not.toHaveBeenCalled();
});

it("never offers a device-origin approval, even after browser scope consent exists", async () => {
  const api = client(), open = vi.fn(async () => {}); api.read.mockResolvedValue(allowed);
  render(<Harness api={api} browserOrigin={false} openOwnerBrowser={open}/>);
  fireEvent.click(screen.getByRole("button", { name: "Select Full Access" }));
  fireEvent.click(await screen.findByRole("button", { name: "Continue in owner browser" }));
  await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  expect(screen.getByText(/This device's turns still require per-operation confirmation/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Allow routine CLI in this private Chat" })).toBeNull();
  expect(api.challenge).not.toHaveBeenCalled(); expect(api.decide).not.toHaveBeenCalled();
});

it.each(["ineligible", "target_required"] as const)("does not offer a grant for %s", async eligibility => {
  const api = client(); api.read.mockResolvedValue({ ...empty, eligibility });
  render(<Harness api={api}/>);
  fireEvent.click(screen.getByRole("button", { name: "Select Full Access" }));
  await waitFor(() => expect(api.read).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Allow routine CLI in this private Chat" })).toBeNull();
  expect(api.challenge).not.toHaveBeenCalled(); expect(api.decide).not.toHaveBeenCalled();
});

it("retained callbacks after unmount cannot decide or create a new nonce", async () => {
  const api = client(); api.read.mockResolvedValue(pending);
  const mounted = renderHook(() => useRoutineFullAccess({ client: api, chatId: "chat_source", identity: "owner", enabled: true,
    browserOrigin: true, permissionMode: "full_access", onPermissionModeChange: vi.fn() }));
  await waitFor(() => expect(mounted.result.current.challenge).not.toBeNull());
  const old = mounted.result.current; mounted.unmount(); old.decide("approve"); old.beginReview();
  expect(api.decide).not.toHaveBeenCalled(); expect(api.challenge).not.toHaveBeenCalled();
});

it("does not offer an expired challenge or silently renew it", async () => {
  const api = client(); api.read.mockResolvedValue({ ...pending, challenge: { ...challenge, expiresAt: "2000-01-01T00:00:00.000Z" } });
  const mounted = renderHook(() => useRoutineFullAccess({ client: api, chatId: "chat_source", identity: "owner", enabled: true,
    browserOrigin: true, permissionMode: "full_access", onPermissionModeChange: vi.fn() }));
  await waitFor(() => expect(mounted.result.current.status).not.toBeNull());
  expect(mounted.result.current.challenge).toBeNull();
  mounted.result.current.decide("approve");
  expect(api.challenge).not.toHaveBeenCalled(); expect(api.decide).not.toHaveBeenCalled();
});

it("serializes decisions and reuses the request ID after an uncertain result on the same challenge", async () => {
  const api = client(); api.read.mockResolvedValue(pending);
  let fail!: (error: Error) => void;
  api.decide.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const mounted = renderHook(() => useRoutineFullAccess({ client: api, chatId: "chat_source", identity: "owner", enabled: true,
    browserOrigin: true, permissionMode: "full_access", onPermissionModeChange: vi.fn() }));
  await waitFor(() => expect(mounted.result.current.challenge).not.toBeNull());
  act(() => { mounted.result.current.decide("approve"); mounted.result.current.decide("approve"); });
  expect(api.decide).toHaveBeenCalledTimes(1); expect(mounted.result.current.busy).toBe(true);
  const first = api.decide.mock.calls[0]![2];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await act(async () => { fail(new Error("Unknown delivery")); });
  expect(mounted.result.current.consent).toBeNull(); expect(mounted.result.current.error).toBeTruthy();
  act(() => mounted.result.current.decide("approve")); expect(api.decide).toHaveBeenCalledTimes(1);
  await act(async () => { await mounted.result.current.refresh(); });
  act(() => mounted.result.current.decide("approve"));
  await waitFor(() => expect(api.decide).toHaveBeenCalledTimes(2));
  expect(api.decide.mock.calls[1]![2]).toEqual(first);
});
it("rejects a retained approval callback after the current same-Chat server view changes", async () => {
  const api = client(); api.read.mockResolvedValueOnce(pending).mockResolvedValue({ ...empty, revision: 4 });
  const mounted = renderHook(() => useRoutineFullAccess({ client: api, chatId: "chat_source", identity: "owner", enabled: true,
    browserOrigin: true, permissionMode: "full_access", onPermissionModeChange: vi.fn() }));
  await waitFor(() => expect(mounted.result.current.challenge).not.toBeNull());
  const decide = mounted.result.current.decide;
  await act(async () => { await mounted.result.current.refresh(); });
  decide("approve"); expect(api.decide).not.toHaveBeenCalled();
});

it("explains a missing private Bot destination on the native fallback and keeps the handoff disabled", async () => {
  const api = client(), open = vi.fn(async () => {}); api.read.mockResolvedValue({ ...empty, eligibility: "target_required" });
  render(<Harness api={api} browserOrigin={false} openOwnerBrowser={open}/>);
  fireEvent.click(screen.getByRole("button", { name: "Select Full Access" }));
  await waitFor(() => expect(screen.getByText(/Choose a private Matrix Bot Chat in Chat Details/)).toBeTruthy());
  expect((screen.getByRole("button", { name: "Continue in owner browser" }) as HTMLButtonElement).disabled).toBe(true);
  expect(open).not.toHaveBeenCalled(); expect(api.decide).not.toHaveBeenCalled();
});
