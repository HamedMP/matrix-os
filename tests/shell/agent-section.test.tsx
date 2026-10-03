// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSection } from "../../shell/src/components/settings/sections/AgentSection.js";
import { IdentityPersonalitySection } from "../../shell/src/components/settings/sections/IdentityPersonalitySection.js";
import * as checkoutActions from "../../shell/src/lib/ai-credit-checkout.js";

const providerControllerState = vi.hoisted(() => ({
  snapshot: {} as unknown,
  error: null as string | null,
  mutate: vi.fn(),
  addCredit: null as null | ((source: string, packageId: "usd_5", requestId: string) => Promise<void>),
}));

vi.mock("@matrix-os/ui", async () => ({
  ...await import("../../packages/ui/src/agents-providers/provider-workflow-client.js"),
  AgentsProvidersView: ({
    onOpenTerminal,
    onOpenBrowser,
    onMutate,
    onAddCredit,
  }: {
    onOpenTerminal: (sessionId: string) => void;
    onOpenBrowser: (path: string) => void;
    onMutate: (intent: unknown) => Promise<boolean>;
    onAddCredit: (source: string, packageId: "usd_5", requestId: string) => Promise<void>;
  }) => {
    providerControllerState.addCredit = onAddCredit;
    return (
    <div>
      <h2>Agents &amp; providers</h2>
      <button onClick={() => onOpenTerminal("provider-login")}>Continue in Terminal</button>
      <button onClick={() => onOpenBrowser("/api/ai/providers/login-attempts/attempt-1/authorize")}>Continue in browser</button>
      <button onClick={() => void onMutate({ type: "start_login", harnessInstanceId: "claude", accountId: null, method: "terminal" })}>Sign in</button>
    </div>
    );
  },
  useProviderSettingsController: () => ({
    snapshot: providerControllerState.snapshot,
    selectedHarnessId: null,
    connectionAttempt: null,
    busy: false,
    error: providerControllerState.error,
    onSelectHarness: vi.fn(),
    refresh: vi.fn(),
    mutate: providerControllerState.mutate,
  }),
  ProviderSettingsTransportError: class ProviderSettingsTransportError extends Error {
    code: string;
    constructor(code: string) {
      super("Provider settings are unavailable.");
      this.code = code;
    }
  },
}));

afterEach(() => {
  cleanup();
  providerControllerState.snapshot = {};
  providerControllerState.error = null;
  providerControllerState.mutate.mockReset();
  providerControllerState.addCredit = null;
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Canvas settings sections", () => {
  it.each(["runtime", "computer", "unmount"])(
    "cancels checkout and rejects a late URL after %s changes in the rendered caller",
    async (change) => {
      window.history.replaceState({}, "", "/vm/alice?runtime=studio");
      let release!: (response: Response) => void;
      let requestSignal!: AbortSignal;
      const fetcher = vi.fn<typeof fetch>((_path, options) => {
        requestSignal = options!.signal!;
        return new Promise((resolve) => { release = resolve; });
      });
      vi.stubGlobal("fetch", fetcher);
      const navigate = vi.fn();
      const realCheckout = checkoutActions.openWebAiCreditCheckout;
      vi.spyOn(checkoutActions, "openWebAiCreditCheckout")
        .mockImplementation((input) => realCheckout({ ...input, navigate }));
      const view = render(<AgentSection />);
      const pending = providerControllerState.addCredit!("matrix", "usd_5", crypto.randomUUID())
        .then(() => true, () => false);
      if (change === "unmount") view.unmount();
      else {
        window.history.replaceState({}, "", change === "runtime" ? "/vm/alice?runtime=other" : "/vm/bob?runtime=studio");
        view.rerender(<AgentSection />);
      }
      release(Response.json({ url: "https://checkout.stripe.com/c/pay/cs_previous" }));
      expect({ completed: await pending, aborted: requestSignal.aborted, opens: navigate.mock.calls.length })
        .toEqual({ completed: false, aborted: true, opens: 0 });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("checks the live runtime before navigating even before a scope effect commits", async () => {
    let release!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    const navigate = vi.fn();
    const realCheckout = checkoutActions.openWebAiCreditCheckout;
    vi.spyOn(checkoutActions, "openWebAiCreditCheckout")
      .mockImplementation((input) => realCheckout({ ...input, navigate }));
    render(<AgentSection />);
    const pending = providerControllerState.addCredit!("matrix", "usd_5", crypto.randomUUID())
      .then(() => true, () => false);
    window.history.replaceState({}, "", "/?runtime=other");
    release(Response.json({ url: "https://checkout.stripe.com/c/pay/cs_previous" }));
    expect(await pending).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not start checkout from a callback whose rendered scope has left", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ url: "https://checkout.stripe.com/c/pay/cs_stale" }));
    vi.stubGlobal("fetch", fetcher);
    const navigate = vi.fn();
    const realCheckout = checkoutActions.openWebAiCreditCheckout;
    vi.spyOn(checkoutActions, "openWebAiCreditCheckout")
      .mockImplementation((input) => realCheckout({ ...input, navigate }));
    const view = render(<AgentSection />);
    const stale = providerControllerState.addCredit!;
    view.unmount();
    await expect(stale("matrix", "usd_5", crypto.randomUUID())).rejects.toThrow("Checkout is unavailable.");
    expect(fetcher).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("opens checkout once while the rendered identity and lifetime are current", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ url: "https://checkout.stripe.com/c/pay/cs_current" }));
    vi.stubGlobal("fetch", fetcher);
    const navigate = vi.fn();
    const realCheckout = checkoutActions.openWebAiCreditCheckout;
    vi.spyOn(checkoutActions, "openWebAiCreditCheckout")
      .mockImplementation((input) => realCheckout({ ...input, navigate }));
    render(<React.StrictMode><AgentSection /></React.StrictMode>);
    await providerControllerState.addCredit!("matrix", "usd_5", crypto.randomUUID());
    expect(fetcher).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("https://checkout.stripe.com/c/pay/cs_current");
  });
  it("renders the shared provider adapter separately from identity and personality", () => {
    vi.stubGlobal("fetch", vi.fn());
    const onOpenTerminal = vi.fn();
    render(<AgentSection onOpenTerminal={onOpenTerminal} />);

    const heading = screen.getByRole("heading", { name: "Agents & providers" });
    expect(heading).toBeVisible();
    expect(heading.closest("[data-provider-settings-adapter='shared']")).toBeTruthy();
    expect(screen.queryByText("SOUL (Personality)")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue in Terminal" }));
    expect(onOpenTerminal).toHaveBeenCalledWith("provider-login");
  });

  it("shows a safe unavailable state when the first provider read fails", () => {
    providerControllerState.snapshot = null;
    providerControllerState.error = "Provider settings are unavailable.";

    render(<AgentSection />);

    expect(screen.getByRole("alert")).toHaveTextContent("Provider settings are unavailable");
    expect(screen.queryByText(/Anthropic|secret|private/i)).toBeNull();
  });

  it("opens the newly returned terminal action from Sign in once, without an effect", async () => {
    const onOpenTerminal = vi.fn();
    providerControllerState.mutate.mockImplementation(async (_intent, options) => {
      options.onLoginAction({ kind: "open_terminal", terminalSessionId: "provider-login" });
      return true;
    });
    const view = render(<AgentSection onOpenTerminal={onOpenTerminal} />);
    expect(onOpenTerminal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(onOpenTerminal).toHaveBeenCalledExactlyOnceWith("provider-login"));
    view.rerender(<AgentSection onOpenTerminal={onOpenTerminal} />);
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
  });

  it("does not open a delayed login action after switching computers", async () => {
    let deliver: (action: unknown) => void = () => {};
    providerControllerState.mutate.mockImplementation(async (_intent, options) => {
      deliver = options.onLoginAction;
      return true;
    });
    const onOpenTerminal = vi.fn();
    render(<AgentSection onOpenTerminal={onOpenTerminal} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    window.history.replaceState({}, "", "/vm/other?runtime=other");
    deliver({ kind: "open_terminal", terminalSessionId: "provider-login" });
    expect(onOpenTerminal).not.toHaveBeenCalled();
  });

  it("persists SOUL to its owner-controlled file", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith("/files/system/soul.md")
        ? new Response("Original soul")
        : Response.json({ displayName: "Matrix" })
    ));
    vi.stubGlobal("fetch", fetcher);
    render(<IdentityPersonalitySection />);

    expect(screen.getByRole("heading", { name: "Identity & personality" })).toBeVisible();

    expect(await screen.findByText("Original soul")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Markdown editor" }), {
      target: { value: "Updated soul" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/files/system/soul.md"),
      expect.objectContaining({ method: "PUT", body: "Updated soul" }),
    ));
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("/api/bridge/data"))).toBe(false);
  });
});
