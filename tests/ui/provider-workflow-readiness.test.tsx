// @vitest-environment jsdom
import React, { StrictMode, useLayoutEffect, useRef } from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderWorkflow } from "@matrix-os/contracts";
import { HarnessWorkflowPanel } from "../../packages/ui/src/agents-providers/HarnessWorkflowPanel";
import type { HarnessWorkflowPanelProps } from "../../packages/ui/src/agents-providers/use-harness-workflow-controller";
import type { ProviderWorkflowClient } from "../../packages/ui/src/agents-providers/types";

afterEach(cleanup);
const option = { id: "anthropic_browser", providerId: "anthropic", authKind: "subscription", method: "browser", billingKind: "subscription", executionKind: "native", availability: "available" } as const;
function setup(id = "harness_kernel") {
  const operation: ProviderWorkflow = { id: `adopt-${id}`, harnessInstanceId: id, kind: "login", state: "succeeded",
    expiresAt: new Date(Date.now() + 60_000).toISOString(), deviceCode: null, authorizationUrl: null, terminalSessionId: null, safeFailure: null, connectionOption: option };
  const startConnection = vi.fn<NonNullable<ProviderWorkflowClient["startConnection"]>>(async () => operation);
  const client: ProviderWorkflowClient = { capabilities: vi.fn(), startConnection, start: vi.fn(), get: vi.fn(), cancel: vi.fn(), submitKey: vi.fn(), logs: vi.fn() };
  const props: HarnessWorkflowPanelProps = {
    harness: { id, harness: "claude", displayName: "Claude Code", installState: "installed", authState: "unknown", selectedAccountId: null },
    capability: { harnessInstanceId: id, harness: "claude", displayName: "Claude Code", installState: "installed", loginMethods: ["browser"], apiKeyProviders: [], connectionOptions: [option], install: false, uninstall: false, logs: false },
    client, disabled: false, availableClaudeAccount: true, onRefresh: vi.fn(), onRefreshAfterLogin: vi.fn(async () => {}), onOpenTerminal: vi.fn(),
  };
  return { props, client, startConnection, operation };
}

/** Dispatch the rendered control's actual click at the first post-commit
 * interaction boundary, before child passive effects initialize anything. */
function FirstCommittedClick({ props, onClick }: { props: HarnessWorkflowPanelProps; onClick: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const button = Array.from(root.current!.querySelectorAll("button")).find(item => item.textContent === "Use connected Claude account");
    if (!button || button.disabled) throw new Error("Expected enabled adoption control");
    button.addEventListener("click", onClick, { once: true });
    button.click();
  }, [onClick]);
  return <div ref={root}><HarnessWorkflowPanel {...props} /></div>;
}

it("admits the first committed adoption click before passive effects", async () => {
  const { props, startConnection, operation } = setup();
  const onClick = vi.fn();
  render(<FirstCommittedClick props={props} onClick={onClick} />);
  expect(onClick).toHaveBeenCalledOnce();
  expect(startConnection).toHaveBeenCalledExactlyOnceWith({ harnessInstanceId: "harness_kernel", optionId: option.id, idempotencyKey: expect.any(String) }, expect.any(AbortSignal));
  await act(async () => {});
  expect(props.onRefreshAfterLogin).toHaveBeenCalledExactlyOnceWith(operation);
  expect(props.client.start).not.toHaveBeenCalled();
});

it("keeps Strict Mode setup inert and aborts its admitted request on disposal", async () => {
  const { props, startConnection } = setup();
  startConnection.mockImplementation(() => new Promise(() => {}));
  const view = render(<StrictMode><HarnessWorkflowPanel {...props} /></StrictMode>);
  expect(startConnection).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Use connected Claude account" })); });
  expect(startConnection).toHaveBeenCalledOnce();
  const signal = startConnection.mock.calls[0]![1] as AbortSignal;
  expect(signal.aborted).toBe(false);
  view.unmount();
  expect(signal.aborted).toBe(true);
});

it("aborts the old account scope and ignores its late failure after replacement", async () => {
  const first = setup(), next = setup("other_harness");
  let rejectOld!: (error: Error) => void;
  first.startConnection.mockImplementation(() => new Promise((_, reject) => { rejectOld = reject; }));
  const view = render(<HarnessWorkflowPanel {...first.props} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Use connected Claude account" })); });
  const oldSignal = first.startConnection.mock.calls[0]![1] as AbortSignal;
  view.rerender(<HarnessWorkflowPanel {...next.props} harness={{ ...next.props.harness, selectedAccountId: "next-account" }} />);
  expect(oldSignal.aborted).toBe(true);
  expect(next.startConnection).not.toHaveBeenCalled();
  await act(async () => { rejectOld(new Error("old account unavailable")); });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  const adopt = screen.getByRole("button", { name: "Use connected Claude account" });
  expect(adopt).toBeEnabled();
  await act(async () => { fireEvent.click(adopt); });
  expect(next.startConnection).toHaveBeenCalledOnce();
  expect(next.props.onRefreshAfterLogin).toHaveBeenCalledExactlyOnceWith(next.operation);
  expect(first.props.onRefreshAfterLogin).not.toHaveBeenCalled();
});
