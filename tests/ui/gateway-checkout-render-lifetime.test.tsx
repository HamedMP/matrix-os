// @vitest-environment jsdom
import React, { Suspense, startTransition, useState } from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayPanel } from "../../packages/ui/src/agents-providers/GatewayPanel";
import { snapshot, start } from "./provider-managed-credit-fixture";

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(start); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it.each([false, true])("settles the committed checkout after an abandoned owner render: %s", async replaceOwner => {
  const value = snapshot();
  value.gatewayPolicy!.topUpEnabled = true;
  let finish!: () => void;
  const checkout = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const replacement = vi.fn();
  let release!: () => void;
  let replacementReady = false;
  const suspended = new Promise<void>(resolve => { release = resolve; });
  let suspendedRenders = 0;
  let replace!: () => void;
  function PendingOwner({ pending }: { pending: boolean }) {
    if (pending && !replacementReady) { suspendedRenders++; throw suspended; }
    return null;
  }
  function View() {
    const [owner, setOwner] = useState({ pending: false });
    const pending = owner.pending;
    replace = () => startTransition(() => setOwner({ pending: true }));
    return <><button onClick={() => setOwner({ pending: false })}>Keep current owner</button><Suspense fallback={<p>Replacing owner</p>}>
      <GatewayPanel source={value.accessSources[0]!} policy={value.gatewayPolicy}
        provider={{ id: "anthropic", displayName: "Anthropic", models: [{ id: "sonnet", displayName: "Sonnet", enabled: true }] }}
        disabled={false} canSetBudget={false} canSetAllowlist={false} canAddCredit
        onMutate={vi.fn()} onRefresh={vi.fn()} onAddCredit={pending ? replacement : checkout} />
      <PendingOwner pending={pending} />
    </Suspense></>;
  }
  render(<View />);
  fireEvent.click(screen.getByRole("button", { name: "Buy credit" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue to checkout" }));
  expect(checkout).toHaveBeenCalledTimes(1);
  if (replaceOwner) {
    await act(async () => { replace(); });
    expect(suspendedRenders).toBeGreaterThan(0);
    expect(screen.queryByText("Replacing owner")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Opening checkout…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Keep current owner" }));
    await act(async () => { replacementReady = true; release(); });
    expect(screen.getByRole("button", { name: "Opening checkout…" })).toBeDisabled();
  }
  await act(async () => { finish(); });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Opening checkout…" })).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Buy credit" })).toBeEnabled();
  expect(replacement).not.toHaveBeenCalled();
});
