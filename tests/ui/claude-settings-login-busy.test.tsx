// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderHarnessInstance, ProviderWorkflowCapability } from "@matrix-os/contracts";
import { HarnessWorkflowPanel } from "../../packages/ui/src/agents-providers/HarnessWorkflowPanel";
import type { ProviderWorkflowClient } from "../../packages/ui/src/agents-providers/types";
import { ProviderWorkflowClientError } from "../../packages/ui/src/agents-providers/provider-workflow-client";
afterEach(cleanup);
const harness = { id: "claude", harness: "claude", displayName: "Claude Code", installState: "installed", authState: "unauthenticated" } as ProviderHarnessInstance;
const capability: ProviderWorkflowCapability = { harnessInstanceId: "claude", harness: "claude", displayName: "Claude Code", installState: "installed", loginMethods: ["browser"], apiKeyProviders: ["anthropic"], install: false, uninstall: false, logs: true };
function fixture() {
  const client: ProviderWorkflowClient = { capabilities: vi.fn(), start: vi.fn().mockRejectedValue(new ProviderWorkflowClientError("conflict")), get: vi.fn(), cancel: vi.fn(), submitCode: vi.fn(), submitKey: vi.fn().mockRejectedValue(new ProviderWorkflowClientError("conflict")), logs: vi.fn() };
  const onOpenTerminal = vi.fn();
  render(<HarnessWorkflowPanel harness={harness} capability={capability} client={client} disabled={false} onRefresh={vi.fn()} onOpenTerminal={onOpenTerminal} onOpenAuthorizationUrl={vi.fn()} />);
  return { client, onOpenTerminal };
}
it("explains a blocked Settings start without opening Terminal or pretending sign-in failed", async () => {
  const { client, onOpenTerminal } = fixture();
  fireEvent.click(screen.getByRole("button", { name: /Claude account/ }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Another connection or agent operation is running. Finish or cancel it, then try again."));
  expect(client.start).toHaveBeenCalledOnce();
  expect(onOpenTerminal).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: /Claude account/ })).toBeEnabled();
});
it("keeps unrelated key-mutation conflicts distinct from sign-in admission", async () => {
  fixture();
  fireEvent.click(screen.getByRole("button", { name: /API key/ }));
  fireEvent.change(screen.getByLabelText("Paste your Anthropic API key"), { target: { value: "synthetic-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not confirm the connection. Check its status before trying again."));
  expect(screen.getByRole("alert")).not.toHaveTextContent("Another connection");
});
