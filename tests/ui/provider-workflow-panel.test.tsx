// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ProviderHarnessInstance,
  ProviderWorkflowCapability,
} from "@matrix-os/contracts";
import { HarnessWorkflowPanel } from "../../packages/ui/src/agents-providers/HarnessWorkflowPanel";
import type { ProviderWorkflowClient } from "../../packages/ui/src/agents-providers/types";
import { ProviderWorkflowClientError } from "../../packages/ui/src/agents-providers/provider-workflow-client";
afterEach(cleanup);
const harness = {
  id: "codex",
  harness: "codex",
  displayName: "Codex",
  installState: "installed",
  authState: "unauthenticated",
} as ProviderHarnessInstance;
const capability: ProviderWorkflowCapability = {
  harnessInstanceId: "codex",
  harness: "codex",
  displayName: "Codex",
  installState: "installed",
  loginMethods: ["device_code"],
  apiKeyProviders: ["openai"],
  install: false,
  uninstall: true,
  logs: true,
};
const client = (): ProviderWorkflowClient => ({
  capabilities: vi.fn().mockResolvedValue([capability]),
  start: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn(),
  submitKey: vi
    .fn()
    .mockRejectedValue(new ProviderWorkflowClientError("rejected")),
  logs: vi.fn().mockResolvedValue({ entries: [] }),
});
it("keeps keys transient and presents safe rejection with retry", async () => {
  const api = client();
  render(
    <HarnessWorkflowPanel
      harness={harness}
      capability={capability}
      client={api}
      disabled={false}
      onRefresh={vi.fn()}
      onOpenTerminal={vi.fn()}
      onOpenAuthorizationUrl={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /API key/ }));
  const input = screen.getByLabelText("Paste your OpenAI API key");
  expect(input).toHaveAttribute("type", "password");
  fireEvent.change(input, { target: { value: "sk-secret-value" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The key could not be verified",
    ),
  );
  expect(document.body.textContent).not.toContain("sk-secret");
  expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(
    screen.queryByLabelText("Paste your OpenAI API key"),
  ).not.toBeInTheDocument();
});
it("install uses actual operation and does not fabricate progress", async () => {
  const api = client();
  api.start = vi.fn().mockResolvedValue({
    id: "wf",
    harnessInstanceId: "codex",
    kind: "install",
    state: "running",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    terminalSessionId: "tws_1:tt_1",
    deviceCode: null,
    authorizationUrl: null,
    safeFailure: null,
  });
  render(
    <HarnessWorkflowPanel
      harness={{ ...harness, installState: "missing" }}
      capability={{ ...capability, install: true }}
      client={api}
      disabled={false}
      onRefresh={vi.fn()}
      onOpenTerminal={vi.fn()}
      onOpenAuthorizationUrl={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument(),
  );
  expect(screen.getByRole("progressbar")).not.toHaveAttribute("value");
  expect(document.body.textContent).not.toContain("62%");
});
it("ignores a key verification that settles after its foreground scope closes", async () => {
  let settle: (() => void) | undefined;
  const api = client();
  api.submitKey = vi.fn(
    () =>
      new Promise((resolve) => {
        settle = () => resolve({ verified: true });
      }),
  );
  const refresh = vi.fn();
  const result = render(
    <HarnessWorkflowPanel
      harness={harness}
      capability={capability}
      client={api}
      disabled={false}
      onRefresh={refresh}
      onOpenTerminal={vi.fn()}
      onOpenAuthorizationUrl={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /API key/ }));
  fireEvent.change(screen.getByLabelText("Paste your OpenAI API key"), {
    target: { value: "sk-secret-value" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  result.unmount();
  settle?.();
  await Promise.resolve();
  expect(refresh).not.toHaveBeenCalled();
});
it("disconnect requires explicit confirmation and keeps optional uninstall unchecked", async () => {
  const api = client();
  const disconnect = vi.fn().mockResolvedValue(true);
  render(
    <HarnessWorkflowPanel
      harness={{ ...harness, authState: "authenticated" }}
      capability={capability}
      client={api}
      disabled={false}
      onRefresh={vi.fn()}
      onOpenTerminal={vi.fn()}
      onOpenAuthorizationUrl={vi.fn()}
      onDisconnect={disconnect}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(disconnect).not.toHaveBeenCalled();
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "Your chats, projects and settings stay",
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Disconnect" })[1]);
  await waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
  expect(api.start).not.toHaveBeenCalled();
});
it("resumes the same operation handle after an accordion reopens", async () => {
  const api = client();
  const operation = {
    id: "wf_saved",
    harnessInstanceId: "codex",
    kind: "login",
    state: "running",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    terminalSessionId: null,
    deviceCode: "ABCD-EFGH",
    authorizationUrl: "https://auth.openai.com/codex/device",
    safeFailure: null,
  };
  api.get = vi.fn().mockResolvedValue(operation);
  api.cancel = vi.fn().mockResolvedValue({ ...operation, state: "cancelled" });
  const refresh = vi.fn();
  render(
    <HarnessWorkflowPanel
      harness={harness}
      capability={capability}
      client={api}
      operationId="wf_saved"
      onOperationId={vi.fn()}
      disabled={false}
      onRefresh={refresh}
      onOpenTerminal={vi.fn()}
      onOpenAuthorizationUrl={vi.fn()}
    />,
  );
  await screen.findByText("ABCD-EFGH");
  expect(api.get).toHaveBeenCalledWith("wf_saved", expect.any(AbortSignal));
  expect(api.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
});
it("clears secret and transient form state when the client identity changes", async () => {
  const api = client();
  const other = client();
  const props = {
    harness,
    capability,
    disabled: false,
    onRefresh: vi.fn(),
    onOpenTerminal: vi.fn(),
    onOpenAuthorizationUrl: vi.fn(),
  };
  const result = render(<HarnessWorkflowPanel {...props} client={api} />);
  fireEvent.click(screen.getByRole("button", { name: /API key/ }));
  fireEvent.change(screen.getByLabelText("Paste your OpenAI API key"), {
    target: { value: "sk-old-owner-secret" },
  });
  result.rerender(<HarnessWorkflowPanel {...props} client={other} />);
  expect(
    screen.queryByLabelText("Paste your OpenAI API key"),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /API key/ }));
  expect(screen.getByLabelText("Paste your OpenAI API key")).toHaveValue("");
  expect(other.submitKey).not.toHaveBeenCalled();
});
it("contains a blocked sign-in popup as a safe actionable failure", async () => {
  const api = client();
  api.get = vi.fn().mockResolvedValue({
    id: "wf",
    harnessInstanceId: "codex",
    kind: "login",
    state: "running",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    terminalSessionId: null,
    deviceCode: "ABCD-EFGH",
    authorizationUrl: "https://auth.openai.com/codex/device",
    safeFailure: null,
  });
  render(
    <HarnessWorkflowPanel
      harness={harness}
      capability={capability}
      client={api}
      operationId="wf"
      disabled={false}
      onRefresh={vi.fn()}
      onOpenTerminal={vi.fn()}
      onOpenAuthorizationUrl={() => {
        throw new Error("private popup internals");
      }}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Open sign-in page" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The connection could not be updated",
    ),
  );
  expect(document.body.textContent).not.toContain("private popup internals");
  expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
});
it("places the single change-account action inside the connected card slot", () => {
  render(
    <HarnessWorkflowPanel
      harness={{ ...harness, authState: "authenticated" }}
      capability={capability}
      client={client()}
      disabled={false}
      onRefresh={vi.fn()}
      onOpenTerminal={vi.fn()}
      renderConnection={(action) => (
        <article data-testid="connected-card">{action}</article>
      )}
    />,
  );
  const action = screen.getByRole("button", { name: "Change account" });
  expect(screen.getByTestId("connected-card")).toContainElement(action);
  expect(
    screen.getAllByRole("button", { name: "Change account" }),
  ).toHaveLength(1);
  fireEvent.click(action);
  expect(screen.getByRole("button", { name: /API key/ })).toBeInTheDocument();
});
it("reports uncertain key-save outcomes and refreshes without discarding masked input", async () => {
  const api = client();
  api.submitKey = vi.fn().mockRejectedValue(new ProviderWorkflowClientError());
  const refresh = vi.fn();
  render(
    <HarnessWorkflowPanel
      harness={harness}
      capability={capability}
      client={api}
      disabled={false}
      onRefresh={refresh}
      onOpenTerminal={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /API key/ }));
  const input = screen.getByLabelText("Paste your OpenAI API key");
  fireEvent.change(input, { target: { value: "sk-mask-retry" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not confirm the connection",
    ),
  );
  expect(refresh).toHaveBeenCalled();
  expect(input).toHaveValue("sk-mask-retry");
  expect(screen.getByRole("alert")).not.toHaveTextContent("verified");
});
it("reuses a pending start receipt key after a lost response", async () => {
  const api = client();
  api.start = vi.fn().mockRejectedValue(new ProviderWorkflowClientError());
  render(
    <HarnessWorkflowPanel
      harness={{ ...harness, installState: "missing" }}
      capability={{ ...capability, install: true }}
      client={api}
      disabled={false}
      onRefresh={vi.fn()}
      onOpenTerminal={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  await waitFor(() => expect(api.start).toHaveBeenCalledTimes(2));
  const calls = vi.mocked(api.start).mock.calls;
  expect(calls[0][0].idempotencyKey).toBe(calls[1][0].idempotencyKey);
});
