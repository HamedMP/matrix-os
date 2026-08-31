// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clerkState = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: true,
  userId: "user_123" as string | null,
  activePlan: null as string | null,
}));

function installClerkMock() {
  vi.doMock("@clerk/nextjs", () => ({
    useAuth: () => ({
      isLoaded: clerkState.isLoaded,
      isSignedIn: clerkState.isSignedIn,
      userId: clerkState.userId,
      has: ({ plan }: { plan: string }) => plan === clerkState.activePlan,
    }),
    useUser: () => ({ user: { publicMetadata: {} } }),
  }));
}

async function loadBillingSection() {
  vi.resetModules();
  installClerkMock();
  return await import("../../shell/src/components/settings/sections/BillingSection.js");
}

async function waitForBillingConfigurator() {
  await waitFor(() => expect(screen.getByTestId("billing-configurator-layout")).toBeTruthy());
}

describe("BillingSection", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    installClerkMock();
    const { resetMatrixBillingAccessCacheForTests } = await import(
      "../../shell/src/hooks/useMatrixBillingAccess.js"
    );
    resetMatrixBillingAccessCacheForTests();
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.userId = "user_123";
    clerkState.activePlan = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ access: { runtimeProxyAllowed: false } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the three-day offer in deterministic screenshot mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_E2E_TEST_BYPASS", "1");
    const { BillingSection } = await loadBillingSection();

    render(<BillingSection mode="provisioning" />);

    expect(screen.queryByText("Start your 3-day free trial")).toBeNull();
    expect(screen.getByRole("button", { name: "Start 3-day trial" })).toBeTruthy();
    vi.unstubAllEnvs();
  });

  it("uses a provider-neutral active fixture in deterministic screenshot mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_E2E_TEST_BYPASS", "1");
    window.history.replaceState({}, "", "/?e2e_billing_state=active");
    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    expect(screen.getByRole("heading", { name: "Builder" })).toBeTruthy();
    expect(screen.getByText("Monthly")).toBeTruthy();
    expect(screen.queryByText(/\$100/)).toBeNull();
    expect(screen.queryByText(/cpx\d+/i)).toBeNull();
    window.history.replaceState({}, "", "/");
    vi.unstubAllEnvs();
  });

  it("waits for Clerk before rendering a subscription state", async () => {
    clerkState.isLoaded = false;
    clerkState.activePlan = "matrix_starter";

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    expect(screen.getByText("Checking")).toBeTruthy();
    expect(screen.getByText("Checking billing status")).toBeTruthy();
    expect(screen.queryByTestId("pricing-table")).toBeNull();
  });

  it("surfaces the subscription state and checkout action", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    const billingHeading = screen.getByRole("heading", { name: "Billing" });
    expect(billingHeading).toBeTruthy();
    expect(billingHeading.parentElement?.parentElement?.className).toContain(
      "font-[family-name:var(--font-geist-sans)]",
    );
    await waitForBillingConfigurator();
    expect(screen.queryByText("Not active")).toBeNull();
    expect(screen.getByText("Choose your Matrix computer")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue to pay" })).toBeTruthy();
    expect(screen.getByText("Secure Stripe checkout")).toBeTruthy();
    expect(screen.queryByText("Visa")).toBeNull();
    expect(screen.queryByText("Mastercard")).toBeNull();
    expect(screen.queryByText("Monthly plan")).toBeNull();
    expect(screen.queryByRole("button", { name: "Annual" })).toBeNull();
    const developerTools = screen.getByRole("heading", { name: "Developer tools" });
    expect(developerTools).toBeTruthy();
    expect(developerTools.closest("section")?.querySelectorAll("img")).toHaveLength(4);
    expect(screen.queryByText("Power, agents, checkout. Your closest region is already selected.")).toBeNull();
    expect(screen.queryByText("Falkenstein, Germany")).toBeNull();
    expect(screen.queryByText("Dedicated VPS prepared before checkout")).toBeNull();
    expect(screen.queryByText("Your files and data persist across restarts")).toBeNull();
    expect(screen.queryByTestId("pricing-table")).toBeNull();
  });

  it.each([1, 7])("shows a concise %i-day trial summary before opening Checkout", async (durationDays) => {
    const trialEnd = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
    const formattedTrialEnd = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(trialEnd);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access: { runtimeProxyAllowed: false },
        trialOffer: { eligible: true, durationDays },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { BillingSection } = await loadBillingSection();

    render(<BillingSection mode="provisioning" />);

    await waitFor(() => expect(screen.getByRole("button", { name: `Start ${durationDays}-day trial` })).toBeTruthy());
    expect(screen.queryByText(`Start your ${durationDays}-day free trial`)).toBeNull();
    expect(screen.queryByText("Card required")).toBeNull();
    expect(screen.getByText("$0 today").classList.contains("text-cream")).toBe(true);
    expect(screen.getByText(`Then $100/month on ${formattedTrialEnd}`)).toBeTruthy();
    expect(screen.queryByText(`Cancel before ${formattedTrialEnd}`)).toBeNull();
    expect(screen.getByRole("button", { name: `Start ${durationDays}-day trial` })).toBeTruthy();
  });

  it("keeps immediate-payment language for additional computers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access: { runtimeProxyAllowed: false },
        trialOffer: { eligible: true, durationDays: 7 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { BillingSection } = await loadBillingSection();

    render(<BillingSection mode="add-computer" checkoutRuntimeSlot="studio" />);

    await waitFor(() => expect(screen.getByText("New subscription")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Continue to pay" })).toBeTruthy();
    expect(screen.queryByText("Start your 7-day free trial")).toBeNull();
  });

  it("does not replace a legacy trial price with the current catalog price", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access: { runtimeProxyAllowed: true, reason: "active" },
        trialOffer: { eligible: false, durationDays: 7 },
        entitlement: {
          source: "stripe",
          planSlug: "matrix_builder",
          status: "trialing",
          maxRuntimeSlots: 1,
          includedRuntimeSlots: 1,
          addonRuntimeSlots: 0,
          defaultServerType: "cpx32",
          allowedServerTypes: ["cpx22", "cpx32"],
          stripeSubscriptionId: "sub_trial",
          stripePriceId: "price_builder_monthly",
          billingInterval: "monthly",
          gracePeriodEndsAt: null,
          trialStartedAt: "2026-08-19T00:00:00.000Z",
          trialEndsAt: "2026-08-26T00:00:00.000Z",
          trialConvertedAt: null,
          firstTrialPaymentFailedAt: null,
          effectiveFrom: "2026-08-19T00:00:00.000Z",
          effectiveUntil: null,
          updatedAt: "2026-08-19T00:00:00.000Z",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    await waitFor(() => expect(screen.getByText("Free trial active")).toBeTruthy());
    expect(screen.getByText("Your first monthly charge is on Aug 26, 2026.")).toBeTruthy();
    expect(screen.queryByText("Your first $100 monthly charge is on Aug 26, 2026.")).toBeNull();
    expect(screen.getByText("Cancel before Aug 26, 2026 to avoid being charged.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manage trial" })).toBeTruthy();
  });

  it("routes a failed trial conversion to payment recovery instead of a new checkout", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access: { runtimeProxyAllowed: false, reason: "payment_required" },
        trialOffer: { eligible: false, durationDays: 7 },
        entitlement: {
          source: "stripe", planSlug: "matrix_builder", status: "past_due",
          maxRuntimeSlots: 1, includedRuntimeSlots: 1, addonRuntimeSlots: 0,
          defaultServerType: "cpx32", allowedServerTypes: ["cpx22", "cpx32"],
          stripeSubscriptionId: "sub_trial", stripePriceId: "price_builder_monthly",
          billingInterval: "monthly", gracePeriodEndsAt: null,
          trialStartedAt: "2026-08-19T00:00:00.000Z", trialEndsAt: "2026-08-26T00:00:00.000Z",
          trialConvertedAt: null, firstTrialPaymentFailedAt: "2026-08-26T00:00:00.000Z",
          effectiveFrom: "2026-08-19T00:00:00.000Z", effectiveUntil: null,
          updatedAt: "2026-08-26T00:00:00.000Z",
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    await waitFor(() => expect(screen.getByText("Payment required")).toBeTruthy());
    expect(screen.getByText("Runtime access is paused until the first payment succeeds.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update payment method" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue to pay" })).toBeNull();
  });

  it("shows a reconnecting billing session state when signed-out app-session billing returns 401", async () => {
    clerkState.isLoaded = true;
    clerkState.isSignedIn = false;
    clerkState.userId = null;
    clerkState.activePlan = null;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access: { runtimeProxyAllowed: false } }), {
        status: 401,
        headers: { "content-type": "application/json", "x-auth-failure": "app-session-stale" },
      }),
    );

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/billing/status",
      expect.objectContaining({
        credentials: "include",
        method: "GET",
      }),
    ));
    await waitFor(() => expect(screen.getByText("Reconnecting")).toBeTruthy());
    expect(screen.getByText("Reconnecting billing session")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue to pay" })).toBeNull();
  });

  it("does not cache signed-out billing 401 and unlocks after session refresh succeeds", async () => {
    clerkState.isLoaded = true;
    clerkState.isSignedIn = false;
    clerkState.userId = null;
    clerkState.activePlan = null;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json", "x-auth-failure": "app-session-stale" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access: { runtimeProxyAllowed: true, reason: "active" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Reconnecting billing session")).toBeTruthy());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    await waitFor(() => expect(screen.getAllByText("Active").length).toBeGreaterThanOrEqual(1));
  });

  it("shows payment setup instead of reconnecting for a plain signed-out billing 401", async () => {
    clerkState.isLoaded = true;
    clerkState.isSignedIn = false;
    clerkState.userId = null;
    clerkState.activePlan = null;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    await waitForBillingConfigurator();
    expect(screen.queryByText("Reconnecting billing session")).toBeNull();
    expect(screen.getByRole("button", { name: "Continue to pay" })).toBeTruthy();
  });

  it("keeps billing status unknown and retries after transient status failures", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access: { runtimeProxyAllowed: false } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Checking billing status")).toBeTruthy();
    expect(screen.queryByText("Not active")).toBeNull();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await waitForBillingConfigurator();
  });

  it("sends the selected US machine shape and preinstalled agents to monthly checkout", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ url: "https://checkout.stripe.test/session" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);
    await waitForBillingConfigurator();

    fireEvent.click(screen.getByRole("button", { name: /Builder/ }));
    expect(screen.queryByRole("button", { name: "Change server location" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Change server location" }));
    fireEvent.click(screen.getByRole("button", { name: /Ashburn, Virginia/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to pay" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/billing/checkout",
        expect.objectContaining({
          body: JSON.stringify({
            planSlug: "matrix_builder",
            interval: "monthly",
            regionSlug: "region_ash",
            serverType: "cpx31",
            developerTools: ["codex", "claude-code", "opencode", "pi"],
          }),
        }),
      ),
    );
  });

  it("opens secure checkout while computer preparation continues in the background", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;
    let resolveCheckout!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (input === "/billing/checkout") {
        return await new Promise<Response>((resolve) => { resolveCheckout = resolve; });
      }
      return new Response(JSON.stringify({ access: { runtimeProxyAllowed: false } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const { BillingSection } = await loadBillingSection();

    const onCheckoutNavigate = vi.fn();
    render(<BillingSection mode="provisioning" onCheckoutNavigate={onCheckoutNavigate} />);
    await waitForBillingConfigurator();
    fireEvent.click(screen.getByRole("button", { name: "Continue to pay" }));

    expect(await screen.findByRole("button", { name: "Opening secure checkout" })).toBeTruthy();
    await act(async () => {
      resolveCheckout(new Response(JSON.stringify({ url: "https://checkout.stripe.test/session" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    });
    expect(onCheckoutNavigate).toHaveBeenCalledWith("https://checkout.stripe.test/session");
  });

  it("closes only the picker on Escape without dismissing the Settings panel", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);
    await waitForBillingConfigurator();

    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Change server location" }));
    expect(screen.getByText("Choose a server location")).toBeTruthy();

    // The Settings panel registers a window-level Escape handler; it must not
    // receive the event once the picker has handled and stopped it.
    const settingsEscape = vi.fn();
    window.addEventListener("keydown", settingsEscape);
    try {
      fireEvent.keyDown(document, { key: "Escape" });
    } finally {
      window.removeEventListener("keydown", settingsEscape);
    }

    expect(screen.queryByText("Choose a server location")).toBeNull();
    expect(settingsEscape).not.toHaveBeenCalled();
  });

  it("includes a safe return path when checkout is launched from CLI device setup", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ url: "https://checkout.stripe.test/session" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const { BillingSection } = await loadBillingSection();

    render(
      <BillingSection
        mode="provisioning"
        checkoutReturnPath="/?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK"
      />,
    );
    await waitForBillingConfigurator();
    fireEvent.click(screen.getByRole("button", { name: "Continue to pay" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/billing/checkout",
        expect.objectContaining({
          body: JSON.stringify({
            planSlug: "matrix_builder",
            interval: "monthly",
            regionSlug: "region_fsn1",
            serverType: "cpx42",
            developerTools: ["codex", "claude-code", "opencode", "pi"],
            returnPath: "/?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK",
          }),
        }),
      ),
    );
  });

  it("explains how to resume a checkout with different selections", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (input === "/billing/checkout") {
        return new Response(JSON.stringify({
          error: "Checkout selection conflicts with an open session",
          code: "checkout_selection_conflict",
          selection: {
            planSlug: "matrix_starter",
            interval: "annual",
            regionSlug: "region_nbg1",
          },
        }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ access: { runtimeProxyAllowed: false } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection mode="provisioning" />);
    await waitForBillingConfigurator();
    fireEvent.click(screen.getByRole("button", { name: "Continue to pay" }));

    expect(
      await screen.findByText(
        "A Starter annual checkout in Nuremberg, Germany is already open. Select those choices to continue it.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Checkout is unavailable. Try again in a moment.")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/billing/checkout",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses provisioning copy when billing is shown before the hosted computer exists", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection mode="provisioning" />);

    expect(screen.getByRole("heading", { name: "Billing" })).toBeTruthy();
    await waitForBillingConfigurator();
    expect(screen.getByText("Choose your Matrix computer")).toBeTruthy();
    expect(screen.queryByText("Computer power")).toBeNull();
    expect(screen.queryByRole("button", { name: "Change computer" })).toBeNull();

    // All plans remain visible in one horizontal choice row.
    const starter = screen.getByRole("button", { name: /^Starter\b/i });
    const builder = screen.getByRole("button", { name: /^Builder\b/i });
    const max = screen.getByRole("button", { name: /^Max\b/i });
    expect(starter).toBeTruthy();
    expect(screen.getByText("$20")).toBeTruthy();
    expect(builder).toBeTruthy();
    expect(screen.getAllByText("$100").length).toBeGreaterThanOrEqual(1);
    expect(max).toBeTruthy();
    expect(screen.getByText("$200")).toBeTruthy();
    expect(starter.parentElement).toBe(builder.parentElement);
    expect(builder.parentElement).toBe(max.parentElement);
    expect(starter.parentElement?.className).toContain("grid-cols-3");
    expect(builder.className).toContain("border-[#0E3422]");
    expect(builder.className).toContain("bg-[#F4F7ED]");
    expect(builder.className).not.toContain("ember");
    expect(screen.getByText("For everyday use")).toBeTruthy();
    expect(screen.getByText("For technical work and building")).toBeTruthy();
    expect(screen.getByText("For serious, demanding workloads")).toBeTruthy();
    expect(screen.queryByText(/CPX22|CPX42|CPX52/)).toBeNull();

    const planLabels = screen.getAllByText("Builder");
    expect(planLabels).toHaveLength(2);
    for (const label of planLabels) {
      expect(label.className).toContain("font-[family-name:var(--font-bricolage)]");
    }

    const codingAgents = screen.getByRole("list", { name: "Coding agents" });
    expect(codingAgents.className).toContain("grid-cols-2");
    const selectedAgent = screen.getByRole("checkbox", { name: "Codex" }).closest("label");
    expect(selectedAgent?.className).toContain("border-[#0E3422]");
    expect(selectedAgent?.className).toContain("bg-[#F4F7ED]");
    expect(selectedAgent?.className).not.toContain("ember");

    // Region options stay out of sight until Advanced settings is expanded.
    expect(screen.queryByRole("button", { name: "Change server location" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Change server location" }));
    expect(screen.getAllByText("Region").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Closest available location is selected")).toBeTruthy();
    expect(screen.getAllByText("🇩🇪").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Falkenstein, Germany").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Nuremberg, Germany")).toBeTruthy();
    expect(screen.getAllByText("🇺🇸").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Ashburn, Virginia")).toBeTruthy();
    expect(screen.getByText("Hillsboro, Oregon")).toBeTruthy();
    expect(screen.getByText("ash")).toBeTruthy();
    expect(screen.getByText("hil")).toBeTruthy();
    expect(screen.queryByText("sin")).toBeNull();
    expect(screen.getByRole("heading", { name: "Developer tools" })).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Codex" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "Continue to pay" })).toBeTruthy();
    expect(screen.queryByTestId("pricing-table")).toBeNull();
  });

  it("prefills the closest server for an American browser timezone", async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      locale: "en-US",
      calendar: "gregory",
      numberingSystem: "latn",
      timeZone: "America/New_York",
    });
    const { BillingSection } = await loadBillingSection();

    render(<BillingSection mode="provisioning" />);

    await waitForBillingConfigurator();
    expect(screen.queryByRole("button", { name: "Change server location" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    expect(screen.getByRole("button", { name: "Change server location" }).textContent).toContain(
      "Ashburn, Virginia",
    );
  });

  it("keeps server location collapsed below computer power and agent provisioning", async () => {
    const { BillingSection } = await loadBillingSection();
    render(<BillingSection mode="provisioning" />);

    await waitForBillingConfigurator();
    const computer = screen.getByRole("group", { name: "Choose your Matrix computer" });
    const agents = screen.getByRole("heading", { name: "Developer tools" });
    const advanced = screen.getByRole("button", { name: "Advanced settings" });
    const follows = Node.DOCUMENT_POSITION_FOLLOWING;

    expect(computer.compareDocumentPosition(agents) & follows).toBeTruthy();
    expect(agents.compareDocumentPosition(advanced) & follows).toBeTruthy();
    expect(advanced.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Change server location" })).toBeNull();

    fireEvent.click(advanced);
    const location = screen.getByRole("button", { name: "Change server location" });
    expect(advanced.getAttribute("aria-expanded")).toBe("true");
    expect(advanced.compareDocumentPosition(location) & follows).toBeTruthy();
    expect(location.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /Ashburn, Virginia/ })).toBeNull();
  });

  it("aligns the provisioning intro and checkout summary in the same layout row", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection mode="provisioning" />);

    await waitForBillingConfigurator();
    const layout = screen.getByTestId("billing-configurator-layout");
    const mainColumn = screen.getByTestId("billing-configurator-main");
    const heading = screen.getByRole("heading", {
      name: "Choose your Matrix computer",
    });
    const summary = screen.getByRole("complementary");

    expect(layout.children).toHaveLength(2);
    expect(layout.children[0]).toBe(mainColumn);
    expect(layout.children[1]).toBe(summary);
    expect(layout.className).toContain("lg:grid-cols-[minmax(0,1fr)_340px]");
    expect(layout.className).toContain("lg:items-start");
    expect(mainColumn.contains(heading)).toBe(true);
  });

  it("uses device setup copy when billing is opened from CLI login", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;

    const { BillingSection } = await loadBillingSection();

    render(
      <BillingSection
        mode="device-setup"
        checkoutReturnPath="/?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK"
      />,
    );

    expect(screen.getByRole("heading", { name: "Billing" })).toBeTruthy();
    await waitForBillingConfigurator();
    expect(screen.queryByText(/returns to CLI device approval/)).toBeNull();
    expect(screen.getByText("Finish billing")).toBeTruthy();
    expect(screen.queryByText("Billing settings")).toBeNull();
    expect(screen.queryByText(/Review your plan and region here/)).toBeNull();
    expect(screen.getByRole("button", { name: "Continue to pay" })).toBeTruthy();
  });

  it.each(["matrix_starter", "matrix_builder", "matrix_max"])(
    "marks billing as active when Clerk grants the %s plan",
    async (plan) => {
    clerkState.isLoaded = true;
    clerkState.activePlan = plan;

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    expect(screen.getAllByText("Active").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Current plan")).toBeTruthy();
    expect(screen.getAllByText("Legacy plan").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId("pricing-table")).toBeNull();
    },
  );

  it("shows current Stripe plan details and portal actions when billing is active", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          access: { runtimeProxyAllowed: true, reason: "active" },
          entitlement: {
            source: "stripe",
            planSlug: "matrix_builder",
            status: "active",
            maxRuntimeSlots: 3,
            includedRuntimeSlots: 2,
            addonRuntimeSlots: 1,
            // Billing defaults are an internal admission/provisioning detail.
            // They can differ from the customer's regional machine (US Builder
            // is cpx31 while this entitlement default is the EU cpx42).
            defaultServerType: "cpx42",
            allowedServerTypes: ["cpx42", "cpx31"],
            stripeSubscriptionId: "sub_123",
            stripePriceId: "price_123",
            gracePeriodEndsAt: "2026-06-02T00:00:00.000Z",
            effectiveFrom: "2026-05-30T00:00:00.000Z",
            effectiveUntil: null,
            updatedAt: "2026-05-30T00:00:00.000Z",
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ url: "https://billing.stripe.test/session" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    await waitFor(() => expect(screen.getAllByText("Builder").length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText("Current plan")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("2 included, 1 add-on")).toBeTruthy();
    expect(screen.queryByText("Machine")).toBeNull();
    expect(screen.queryByText(/cpx\d+/i)).toBeNull();
    expect(screen.queryByText(/hetzner/i)).toBeNull();
    expect(screen.getByText("Receipts and payment")).toBeTruthy();
    expect(screen.getByText("Canceling")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "View receipts" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/billing/portal",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("does not mark billing active for the legacy Clerk early_adopter plan", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = "early_adopter";

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    await waitForBillingConfigurator();
    expect(screen.queryByText("Not active")).toBeNull();
  });
});
