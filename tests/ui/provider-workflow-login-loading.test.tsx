// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderWorkflowUIOperation, ProviderWorkflowUICapability, ProviderWorkflowClient } from "../../packages/ui/src/agents-providers/types";
import { HarnessWorkflowPanel } from "../../packages/ui/src/agents-providers/HarnessWorkflowPanel";

const browser = { id: "claude:anthropic:browser", providerId: "anthropic", authKind: "subscription", method: "browser", billingKind: "subscription", executionKind: "native", availability: "available" } as const;
const key = { id: "claude:anthropic:key", providerId: "anthropic", authKind: "api_key", billingKind: "api_key", executionKind: "native", availability: "available" } as const;
const capability: ProviderWorkflowUICapability = { harnessInstanceId: "claude", harness: "claude", displayName: "Claude Code", installState: "installed", loginMethods: ["browser"], apiKeyProviders: ["anthropic"], install: false, uninstall: false, logs: false, connectionOptions: [browser, key] };
const harness = { id: "claude", harness: "claude", displayName: "Claude Code", installState: "installed", authState: "unauthenticated" } as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function setup() {
  vi.useFakeTimers();
  const response = deferred<ProviderWorkflowUIOperation>();
  const operation: ProviderWorkflowUIOperation = { id: "browser-attempt", harnessInstanceId: "claude", kind: "login", state: "running", expiresAt: new Date(Date.now() + 60_000).toISOString(), terminalSessionId: null, deviceCode: null, authorizationUrl: null, safeFailure: null, connectionOption: browser };
  const client: ProviderWorkflowClient = { capabilities: vi.fn(), start: vi.fn(), startConnection: vi.fn(() => response.promise), get: vi.fn().mockResolvedValue(operation), cancel: vi.fn().mockResolvedValue({ ...operation, state: "cancelled" }), submitKey: vi.fn(), submitConnectionKey: vi.fn(), submitCode: vi.fn(), logs: vi.fn() };
  const props = { harness, capability, client, disabled: false, onRefresh: vi.fn(), onOpenTerminal: vi.fn(), onOpenAuthorizationUrl: vi.fn() };
  const view = render(<HarnessWorkflowPanel {...props} />);
  return { response, operation, client, props, view };
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("indicates both delayed start and URL preparation before offering the browser link", async () => {
  const { response, operation, client, props } = setup();
  const option = screen.getByRole("button", { name: /Claude account · Sign in in browser/ });
  fireEvent.click(option);
  expect(screen.getByRole("status", { name: "Starting sign-in" })).toHaveTextContent("Starting sign-in…");
  expect(screen.getByRole("heading", {name: "Finish signing in to Claude"})).toBeInTheDocument();
  expect(option).toHaveAttribute("aria-busy", "true");
  expect(option.querySelector(".matrix-ap-loading-spinner")).not.toBeNull();
  expect(screen.getByRole("button", { name: /Anthropic API key/ })).toBeDisabled();
  fireEvent.click(option);
  expect(client.startConnection).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "Open sign-in page" })).not.toBeInTheDocument();

  await act(async () => response.resolve(operation));
  expect(screen.queryByRole("status", { name: "Starting sign-in" })).not.toBeInTheDocument();
  const preparing = screen.getByRole("status", { name: "Preparing sign-in page" });
  expect(preparing).toHaveTextContent("Preparing sign-in page…");
  expect(preparing.querySelector(".matrix-ap-loading-spinner")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  expect(screen.queryByText(/Waiting for sign-in/)).not.toBeInTheDocument();

  vi.mocked(client.get).mockResolvedValue({ ...operation, authorizationUrl: "https://claude.com/cai/oauth/authorize?state=fixture" });
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(screen.queryByRole("status", { name: "Preparing sign-in page" })).not.toBeInTheDocument();
  expect(screen.getByRole("status", { name: "Waiting for sign-in" })).toHaveTextContent("Waiting for sign-in.");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open sign-in page" })));
  expect(props.onOpenAuthorizationUrl).toHaveBeenCalledOnce();
  expect(client.startConnection).toHaveBeenCalledOnce();
});

it("clears startup loading after a rejected start and allows an explicit retry", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { response, client } = setup();
  const option = screen.getByRole("button", { name: /Claude account · Sign in in browser/ });
  fireEvent.click(option);
  expect(screen.getByRole("status", { name: "Starting sign-in" })).toBeInTheDocument();
  await act(async () => response.reject(new Error("fixture failure")));
  expect(screen.getByRole("alert")).toHaveTextContent("The connection could not be updated.");
  expect(screen.queryByRole("status", { name: "Starting sign-in" })).not.toBeInTheDocument();
  expect(screen.queryByRole("status", { name: "Preparing sign-in page" })).not.toBeInTheDocument();
  expect(option).not.toHaveAttribute("aria-busy", "true");
  expect(option).toBeEnabled();
  expect(screen.getByRole("button", { name: /Anthropic API key/ })).toBeEnabled();
  const retry = deferred<ProviderWorkflowUIOperation>();
  vi.mocked(client.startConnection!).mockImplementation(() => retry.promise);
  fireEvent.click(option);
  expect(screen.getByRole("status", { name: "Starting sign-in" })).toBeInTheDocument();
  expect(client.startConnection).toHaveBeenCalledTimes(2);
});

it("cancels while the sign-in page is preparing and removes the progress feedback", async () => {
  const { response, operation, client, props } = setup();
  fireEvent.click(screen.getByRole("button", { name: /Sign in in browser/ }));
  await act(async () => response.resolve(operation));
  expect(screen.getByRole("status", { name: "Preparing sign-in page" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => {});
  expect(client.cancel).toHaveBeenCalledWith(operation.id, expect.any(AbortSignal));
  expect(props.onRefresh).toHaveBeenCalledOnce();
  expect(screen.queryByRole("status", { name: "Preparing sign-in page" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Sign in in browser/ })).toBeEnabled();
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(client.get).not.toHaveBeenCalled();
});

it("fences delayed startup feedback and receipts when the client scope changes", async () => {
  const { response, operation, props, view } = setup();
  fireEvent.click(screen.getByRole("button", { name: /Sign in in browser/ }));
  const newClient = { ...props.client, startConnection: vi.fn() };
  view.rerender(<HarnessWorkflowPanel {...props} client={newClient} />);
  expect(screen.queryByRole("status", { name: "Starting sign-in" })).not.toBeInTheDocument();
  await act(async () => response.resolve(operation));
  expect(screen.queryByText("Finish signing in to Claude")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Sign in in browser/ })).toBeEnabled();
  expect(props.onRefresh).not.toHaveBeenCalled();
});

it("shows immediate startup feedback for the historical browser capability too", async () => {
  const { response, operation, props, view } = setup();
  const client = { ...props.client, start: vi.fn(() => response.promise) };
  view.rerender(<HarnessWorkflowPanel {...props} capability={{ ...capability, connectionOptions: undefined }} client={client} />);
  const option = screen.getByRole("button", { name: /Claude account/ });
  fireEvent.click(option);
  expect(screen.getByRole("status", { name: "Starting sign-in" })).toBeInTheDocument();
  expect(option).toHaveAttribute("aria-busy", "true");
  await act(async () => response.resolve(operation));
  expect(screen.getByRole("status", { name: "Preparing sign-in page" })).toBeInTheDocument();
  expect(client.start).toHaveBeenCalledWith(expect.objectContaining({method: "browser"}), expect.any(AbortSignal));
  expect(client.startConnection).not.toHaveBeenCalled();
});


it.each(["succeeded", "failed", "expired"] as const)("clears page preparation when polling returns %s", async state => {
  const { response, operation, client, props } = setup();
  fireEvent.click(screen.getByRole("button", { name: /Sign in in browser/ }));
  await act(async () => response.resolve(operation));
  expect(screen.getByRole("status", { name: "Preparing sign-in page" })).toBeInTheDocument();
  vi.mocked(client.get).mockResolvedValue({ ...operation, state, safeFailure: state === "succeeded" ? null : "unavailable" });
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(screen.queryByRole("status", { name: "Preparing sign-in page" })).not.toBeInTheDocument();
  expect(screen.queryByRole("status", { name: "Waiting for sign-in" })).not.toBeInTheDocument();
  expect(document.querySelector(".matrix-ap-loading-spinner")).toBeNull();
  if (state === "succeeded") expect(props.onRefresh).toHaveBeenCalledOnce();
  else expect(screen.getByRole("alert")).toHaveTextContent(state === "expired" ? "The sign-in code expired." : "Couldn't connect.");
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(client.get).toHaveBeenCalledOnce();
});

it("ignores a delayed URL receipt after a scope change during page preparation", async () => {
  const { response, operation, client, props, view } = setup();
  const poll = deferred<ProviderWorkflowUIOperation>();
  vi.mocked(client.get).mockImplementation(() => poll.promise);
  fireEvent.click(screen.getByRole("button", { name: /Sign in in browser/ }));
  await act(async () => response.resolve(operation));
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(client.get).toHaveBeenCalledOnce();
  view.rerender(<HarnessWorkflowPanel {...props} client={{ ...client }} />);
  await act(async () => poll.resolve({ ...operation, authorizationUrl: "https://claude.com/cai/oauth/authorize?state=old-scope" }));
  expect(screen.queryByText("Finish signing in to Claude")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open sign-in page" })).not.toBeInTheDocument();
  expect(document.querySelector(".matrix-ap-loading-spinner")).toBeNull();
  expect(props.onRefresh).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(client.get).toHaveBeenCalledOnce();
});


it("keeps a spinner between successful authorization and completed account refresh", async () => {
  const { response, operation, client, props, view } = setup();
  const refresh = deferred<void>();
  props.onRefresh.mockImplementation(() => refresh.promise);
  const stateChange = vi.fn();
  view.rerender(<HarnessWorkflowPanel {...props} onStateChange={stateChange} />);
  fireEvent.click(screen.getByRole("button", { name: /Sign in in browser/ }));
  await act(async () => response.resolve(operation));
  vi.mocked(client.get).mockResolvedValue({ ...operation, state: "succeeded" });
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(screen.getByRole("status", { name: "Updating connection" })).toHaveTextContent("Sign-in complete. Updating connection…");
  expect(document.querySelector(".matrix-ap-loading-spinner")).not.toBeNull();
  expect(stateChange).toHaveBeenLastCalledWith("Connecting");
  expect(screen.getByRole("button", { name: /Sign in in browser/ })).toBeDisabled();
  await act(async () => refresh.resolve());
  expect(screen.queryByRole("status", { name: "Updating connection" })).not.toBeInTheDocument();
  expect(stateChange).toHaveBeenLastCalledWith(null);
});


it.each(["timeout", "failure"] as const)("stops completion progress and offers a status check on refresh %s", async mode => {
  const { response, operation, client, props } = setup();
  const refresh = deferred<void>(); props.onRefresh.mockImplementation(() => refresh.promise);
  fireEvent.click(screen.getByRole("button", { name: /Sign in in browser/ }));
  await act(async () => response.resolve(operation));
  vi.mocked(client.get).mockResolvedValue({...operation,state:"succeeded"});
  await act(() => vi.advanceTimersByTimeAsync(2000));
  if (mode === "timeout") await act(() => vi.advanceTimersByTimeAsync(30_000));
  else await act(async () => refresh.reject(new Error("unavailable")));
  expect(screen.queryByRole("status",{name:"Updating connection"})).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Sign-in completed.");
  expect(screen.getByRole("button",{name:"Check connection"})).toBeEnabled();
  expect(client.startConnection).toHaveBeenCalledOnce();
});
it("ignores completion refresh settling after switching runtime", async () => {
  const { response, operation, client, props, view } = setup();
  const refresh = deferred<void>();props.onRefresh.mockImplementation(() => refresh.promise);
  fireEvent.click(screen.getByRole("button",{name:/Sign in in browser/}));
  await act(async () => response.resolve(operation));
  vi.mocked(client.get).mockResolvedValue({...operation,state:"succeeded"});
  await act(() => vi.advanceTimersByTimeAsync(2000));
  view.rerender(<HarnessWorkflowPanel {...props} client={{...client}} />);
  await act(async () => refresh.reject(new Error("old runtime")));
  expect(screen.queryByRole("status",{name:"Updating connection"})).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
