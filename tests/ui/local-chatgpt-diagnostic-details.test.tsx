// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { LocalChatgptSubscription } from "../../packages/ui/src/agents-providers/LocalChatgptSubscription.js";
import type { LocalChatgptPlanClient, LocalChatgptPlanStatus } from "../../packages/ui/src/agents-providers/local-chatgpt-plan-client.js";
import { createDesktopChatgptPlanClient } from "../../desktop/src/renderer/src/features/settings/local-chatgpt-plan-client.js";

afterEach(cleanup);
const diagnostic = { phase: "vault_decrypt", category: "unavailable", at: "2026-10-16T06:00:00.000Z", correlationId: "829fe2b8-d668-4d3d-800e-79d201e80d53", ownerMatches: false };
const disconnected: LocalChatgptPlanStatus = { state: "disconnected", scope: "this_device", models: [], grant: { revision: 0, enabled: false, background: false }, bridgeConnected: false, revocation: "none" };
const props = { disabled: false, readOnly: false, onChanged: vi.fn() };
function client(cached: unknown = diagnostic): LocalChatgptPlanClient {
  return {
    status: vi.fn().mockRejectedValue(new Error("private failure")),
    connect: vi.fn().mockResolvedValue(disconnected), cancel: vi.fn().mockResolvedValue(disconnected),
    disconnect: vi.fn().mockResolvedValue(disconnected), refreshModels: vi.fn().mockResolvedValue(disconnected), setGrant: vi.fn().mockResolvedValue(disconnected),
    getLastDiagnostic: vi.fn().mockReturnValue(cached),
  } as LocalChatgptPlanClient;
}
async function showDetails() {
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Connection details" }));
}

it("shows a natural Desktop cached failure without another IPC or mutation", async () => {
  const call = vi.fn().mockResolvedValue({ kind: "status_failure", diagnostic });
  const native = createDesktopChatgptPlanClient({ runtimeSlot: "fixture", authGeneration: 1 }, () => true, call);
  render(<LocalChatgptSubscription {...props} client={native}/>);
  await showDetails();
  expect(screen.getByRole("region", { name: "Connection details" })).toHaveTextContent("vault_decrypt");
  expect(screen.getByText(diagnostic.correlationId)).toBeVisible();
  expect(screen.getByText("Owner matches: false")).toBeVisible();
  expect(screen.queryByText(/Runtime slot matches/)).toBeNull();
  expect(call).toHaveBeenCalledTimes(1);
  expect(call.mock.calls[0][0]).toBe("chatgpt-plan:status");
  expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeDisabled();
});

it.each(["catalog", "peer"])("preserves a valid %s error snapshot while inspecting its cached detail", async phase => {
  const status = { ...disconnected, state: "error" };
  const call = vi.fn().mockResolvedValue({ kind: "status_result", status, diagnostic: { ...diagnostic, phase, httpStatus: 503 } });
  const native = createDesktopChatgptPlanClient({ runtimeSlot: "fixture", authGeneration: 1 }, () => true, call);
  render(<LocalChatgptSubscription {...props} client={native}/>);
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Connection details" }));
  expect(screen.getByText(phase)).toBeVisible();
  expect(screen.getByText("HTTP status: 503")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(call).toHaveBeenCalledTimes(1);
});

it.each([
  ["absent", null], ["unknown phase", { ...diagnostic, phase: "secret-path" }],
  ["unknown category", { ...diagnostic, category: "raw-error" }],
  ["raw secret extra field", { ...diagnostic, token: "private-secret-do-not-render" }],
  ["path extra field", { ...diagnostic, path: "/private-secret-do-not-render" }],
  ["invalid timestamp", { ...diagnostic, at: "private-secret-do-not-render" }],
  ["invalid correlation", { ...diagnostic, correlationId: "private-secret-do-not-render" }],
  ["unlisted HTTP", { ...diagnostic, httpStatus: 418 }],
  ["nonboolean comparison", { ...diagnostic, ownerMatches: "private-secret-do-not-render" }],
])("makes %s diagnostic unavailable without rendering unvalidated fields", async (_name, cached) => {
  const native = client(cached);
  const view = render(<LocalChatgptSubscription {...props} client={native}/>);
  await showDetails();
  expect(screen.getByText("Diagnostic information is unavailable.")).toBeVisible();
  expect(view.container).not.toHaveTextContent("private-secret-do-not-render");
  expect(view.container).not.toHaveTextContent("vault_decrypt");
  expect(native.status).toHaveBeenCalledTimes(1);
  expect(native.connect).not.toHaveBeenCalled(); expect(native.setGrant).not.toHaveBeenCalled();
});

it.each(["missing", "throwing"])("supports a %s getter without logging or starting work", async kind => {
  const native = client();
  if (kind === "missing") delete native.getLastDiagnostic;
  else native.getLastDiagnostic = () => { throw new Error("private-secret-do-not-render"); };
  const view = render(<LocalChatgptSubscription {...props} client={native}/>);
  await showDetails();
  expect(screen.getByText("Diagnostic information is unavailable.")).toBeVisible();
  expect(view.container).not.toHaveTextContent("private-secret-do-not-render");
  expect(native.status).toHaveBeenCalledTimes(1);
});

it("closes details as an ordinary retry starts and stays closed on success", async () => {
  const native = client(); let settle!: (value: LocalChatgptPlanStatus) => void;
  render(<LocalChatgptSubscription {...props} client={native}/>);
  await showDetails();
  vi.mocked(native.status).mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  expect(screen.queryByRole("region", { name: "Connection details" })).toBeNull();
  expect(screen.queryByText("vault_decrypt")).toBeNull();
  await act(async () => settle(disconnected));
  expect(screen.queryByRole("region", { name: "Connection details" })).toBeNull();
  expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeEnabled();
});

it("hides old details immediately on identity replacement and ignores an obsolete failure", async () => {
  const native = client(), next = client(null);
  const view = render(<LocalChatgptSubscription {...props} client={native}/>);
  await showDetails();
  view.rerender(<LocalChatgptSubscription {...props} client={next}/>);
  expect(screen.queryByText("vault_decrypt")).toBeNull();
  await screen.findByRole("alert");
  expect(screen.queryByRole("region", { name: "Connection details" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Connection details" }));
  expect(screen.getByText("Diagnostic information is unavailable.")).toBeVisible();
});

it("closes a current receipt before a refresh aborts its operation", async () => {
  const call = vi.fn().mockResolvedValue({ kind: "status_failure", diagnostic });
  const native = createDesktopChatgptPlanClient({ runtimeSlot: "fixture", authGeneration: 1 }, () => true, call);
  const view = render(<LocalChatgptSubscription {...props} client={native} refreshRevision={0}/>);
  await showDetails();
  call.mockImplementationOnce(() => new Promise(() => {}));
  view.rerender(<LocalChatgptSubscription {...props} client={native} refreshRevision={1}/>);
  expect(screen.queryByRole("region", { name: "Connection details" })).toBeNull();
  expect(native.getLastDiagnostic()).toBeNull();
  view.unmount();
  expect(native.getLastDiagnostic()).toBeNull();
});

it("revalidates a locally invalidated cached receipt instead of retaining a rendered copy", async () => {
  let current = true;
  const call = vi.fn().mockResolvedValue({ kind: "status_failure", diagnostic });
  const native = createDesktopChatgptPlanClient({ runtimeSlot: "fixture", authGeneration: 1 }, () => current, call);
  const view = render(<LocalChatgptSubscription {...props} client={native}/>);
  await showDetails(); current = false;
  view.rerender(<LocalChatgptSubscription {...props} client={native} readOnly/>);
  expect(screen.queryByText("vault_decrypt")).toBeNull();
  expect(screen.getByText("Diagnostic information is unavailable.")).toBeVisible();
  expect(call).toHaveBeenCalledTimes(1);
});

it("allows cached inspection in read-only mode without enabling recovery or consent", async () => {
  const native = client();
  render(<LocalChatgptSubscription {...props} client={native} readOnly/>);
  await showDetails();
  expect(screen.getByText("vault_decrypt")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Check connection" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Continue with ChatGPT" })).toBeNull();
  expect(native.status).toHaveBeenCalledTimes(1); expect(native.connect).not.toHaveBeenCalled();
});

it("shows only supplied HTTP and comparison fields from a valid cached receipt", async () => {
  const native = client({ ...diagnostic, phase: "peer", httpStatus: 503, runtimeSlotMatches: true, authGenerationMatches: false });
  render(<LocalChatgptSubscription {...props} client={native}/>);
  await showDetails();
  expect(screen.getByText("HTTP status: 503")).toBeVisible();
  expect(screen.getByText("Runtime slot matches: true")).toBeVisible();
  expect(screen.getByText("Auth generation matches: false")).toBeVisible();
  expect(native.status).toHaveBeenCalledTimes(1);
});

it("hides details opened during a pending read when that read succeeds", async () => {
  const native = client(); let settle!: (value: LocalChatgptPlanStatus) => void;
  vi.mocked(native.status).mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
  render(<LocalChatgptSubscription {...props} client={native}/>);
  fireEvent.click(screen.getByRole("button", { name: "Connection details" }));
  expect(screen.getByText("vault_decrypt")).toBeVisible();
  await act(async () => settle(disconnected));
  expect(screen.queryByRole("region", { name: "Connection details" })).toBeNull();
});
