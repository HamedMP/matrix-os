// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FreeAiCreditUnavailableError } from "@matrix-os/contracts";
import { GatewayPanel } from "../../packages/ui/src/agents-providers/GatewayPanel";
import { openWebAiCreditCheckout } from "../../shell/src/lib/ai-credit-checkout";
import { openAiCreditCheckout } from "../../desktop/src/renderer/src/features/settings/provider-settings-desktop-adapter";
import { createApiClient } from "../../desktop/src/renderer/src/lib/api";
import { snapshot, start } from "./provider-managed-credit-fixture";

/**
 * ENG-520 launch guard: `POST /billing/ai-credit/checkout` answers a free owner
 * with 409 `free_upgrade_unavailable`. The web client (Web Desktop, Web Canvas,
 * Web Mobile) and the Electron Desktop client turn that code into a typed error,
 * and the shared GatewayPanel shows fixed coming-soon copy. Native Mobile has no
 * credit purchase. Faults detected: the refusal shown as a generic failure, a
 * browser opened, or the server's error string rendered.
 */

const refusal = () => Response.json(
  { code: "free_upgrade_unavailable", error: "pg: secret /srv/path" },
  { status: 409 },
);

describe("free owner AI credit refusal", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(start); });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("web client rejects with the typed error and never navigates", async () => {
    const navigate = vi.fn();
    await expect(openWebAiCreditCheckout({
      packageId: "usd_5", requestId: crypto.randomUUID(), fetcher: vi.fn(async () => refusal()), navigate,
    })).rejects.toBeInstanceOf(FreeAiCreditUnavailableError);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("Electron client rejects with the typed error and never opens a browser", async () => {
    const client = createApiClient({
      baseUrl: "https://runtime.example.test", getRuntimeSlot: () => "primary", fetchFn: vi.fn(async () => refusal()),
    });
    const openExternal = vi.fn();
    await expect(openAiCreditCheckout({
      api: client, runtimeSlot: "primary", packageId: "usd_5", requestId: crypto.randomUUID(), openExternal,
    })).rejects.toBeInstanceOf(FreeAiCreditUnavailableError);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it.each([
    ["the coming-soon copy for a free owner", new FreeAiCreditUnavailableError(), "AI credit for free computers is coming soon."],
    ["the generic copy for any other failure", new Error("pg: secret"), "Checkout could not be opened. Try again."],
  ])("GatewayPanel shows %s", async (_name, error, message) => {
    const value = snapshot();
    value.gatewayPolicy!.topUpEnabled = true;
    render(<GatewayPanel source={value.accessSources[0]!} policy={value.gatewayPolicy}
      provider={{ id: "anthropic", displayName: "Anthropic", models: [{ id: "sonnet", displayName: "Sonnet", enabled: true }] }}
      disabled={false} canSetBudget={false} canSetAllowlist={false} canAddCredit
      onMutate={vi.fn()} onRefresh={vi.fn()} onAddCredit={vi.fn(async () => { throw error; })} />);
    fireEvent.click(screen.getByRole("button", { name: "Buy credit" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to checkout" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText(/pg: secret/)).not.toBeInTheDocument();
  });
});
