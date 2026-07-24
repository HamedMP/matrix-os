// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clerkState = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: true,
  user: {
    fullName: null as string | null,
    username: null as string | null,
    imageUrl: "",
    primaryEmailAddress: { emailAddress: "neo@example.com" },
  },
  signOut: vi.fn(async () => undefined),
  openUserProfile: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  RedirectToSignIn: () => <div>Redirecting to sign in</div>,
  useAuth: () => ({
    isLoaded: clerkState.isLoaded,
    isSignedIn: clerkState.isSignedIn,
    userId: clerkState.isSignedIn ? "user_123" : null,
    has: () => false,
    signOut: clerkState.signOut,
  }),
  useUser: () => ({ user: clerkState.user }),
  useClerk: () => ({ openUserProfile: clerkState.openUserProfile }),
}));

vi.mock("@/lib/posthog-client", () => ({
  capturePostHogEvent: vi.fn(),
  capturePostHogLog: vi.fn(),
}));

const inventory = {
  items: [
    {
      handle: "neo",
      runtimeSlot: "primary",
      label: "Main Computer",
      availability: "available",
      kind: "customer",
      versionLabel: "stable",
      gatewayPath: "/vm/neo",
      capabilities: ["matrixComputerInventoryV1"],
    },
    {
      handle: "neo-studio",
      runtimeSlot: "studio",
      label: "Additional Computer",
      availability: "available",
      kind: "customer",
      versionLabel: "v2026.07.18",
      gatewayPath: "/vm/neo-studio?runtime=studio",
      capabilities: ["matrixComputerInventoryV1"],
    },
    {
      handle: "pr-1024",
      runtimeSlot: "pr-1024",
      label: "Preview Computer",
      availability: "starting",
      kind: "preview",
      versionLabel: "Version pending",
      gatewayPath: "/vm/pr-1024?runtime=pr-1024",
      capabilities: ["matrixComputerInventoryV1"],
    },
  ],
  selectedSlot: "studio",
  hasMore: false,
  limit: 20,
};

function billingStatus(maxRuntimeSlots = 3, source: "stripe" | "override" = "stripe") {
  return {
    entitlement: {
      source,
      planSlug: source === "override" ? "internal" : "matrix_builder",
      status: "active",
      maxRuntimeSlots,
      includedRuntimeSlots: maxRuntimeSlots,
      addonRuntimeSlots: 0,
      defaultServerType: "cpx32",
      allowedServerTypes: ["cpx22", "cpx32"],
      stripeSubscriptionId: source === "stripe" ? "sub_123" : null,
      stripePriceId: source === "stripe" ? "price_builder_monthly" : null,
      gracePeriodEndsAt: null,
      effectiveFrom: "2026-07-01T00:00:00.000Z",
      effectiveUntil: null,
      updatedAt: "2026-07-18T00:00:00.000Z",
    },
    access: { runtimeProxyAllowed: true, reason: "active" },
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function installFetchRouter(options: {
  computerInventory?: typeof inventory;
  billing?: ReturnType<typeof billingStatus>;
  provision?: Response;
  journey?: Record<string, unknown>;
  checkout?: Response | (() => Response);
} = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/auth/computers") return json(options.computerInventory ?? inventory);
    if (url.startsWith("/billing/status")) return json(options.billing ?? billingStatus());
    if (url === "/api/auth/provision-runtime") {
      return options.provision ?? json({ status: "provisioning", runtimeSlot: "new-computer" }, 202);
    }
    if (url.startsWith("/api/journey?runtimeSlot=")) {
      return json(options.journey ?? {
        phase: "provisioning",
        detail: "Building your Matrix computer…",
        nextAction: { kind: "wait" },
        progress: { stage: "booting", startedAt: "2026-07-18T00:00:00.000Z" },
      });
    }
    if (url === "/api/journey/retry-provision") {
      return json({ status: "started", journey: { phase: "provisioning" } });
    }
    if (url === "/billing/checkout") {
      return typeof options.checkout === "function"
        ? options.checkout()
        : options.checkout ?? json({ url: "https://checkout.stripe.test/session" });
    }
    if (url === "/api/auth/app-session" && init?.method === "DELETE") return json({ cleared: true });
    throw new Error(`Unhandled test request: ${url}`);
  });
}

async function renderManager(props: Record<string, unknown> = {}) {
  const { RuntimeManager } = await import("../../shell/src/components/runtime/RuntimeManager.js");
  return render(<RuntimeManager {...props} />);
}

async function renderOnboarding(
  props: Record<string, unknown> = {},
  path = "/onboarding/computer",
) {
  window.history.replaceState({}, "", path);
  return renderManager({ ...props, surface: "onboarding" });
}

async function beginNamedComputer(name: string) {
  const input = await screen.findByRole("textbox", { name: "Computer name" });
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(await screen.findByRole("button", { name: /Continue (setup|to pay)/ }));
}

describe("RuntimeManager", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.history.replaceState({}, "", "/runtime");
    window.sessionStorage.clear();
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.user.fullName = null;
    clerkState.user.username = null;
    clerkState.user.primaryEmailAddress.emailAddress = "neo@example.com";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes safe readable slots and rejects reserved, duplicate, empty, and long names", async () => {
    const { normalizeRuntimeSlotName, validateRuntimeName } = await import(
      "../../shell/src/components/runtime/runtime-name.js"
    );

    expect(normalizeRuntimeSlotName("  Design Studio  ")).toBe("design-studio");
    expect(normalizeRuntimeSlotName("Design Studio")).toBe("design-studio");
    expect(validateRuntimeName("Primary", [])).toMatchObject({ valid: false });
    expect(validateRuntimeName("Studio", ["studio"])).toMatchObject({ valid: false });
    expect(validateRuntimeName("!!!", [])).toMatchObject({ valid: false });
    expect(validateRuntimeName("a".repeat(33), [])).toMatchObject({ valid: false });
    expect(validateRuntimeName("Design Studio", [])).toEqual({
      valid: true,
      slot: "design-studio",
      title: "Design Studio",
    });
  });

  it("shows the Clerk profile fallback and authoritative computer links", async () => {
    installFetchRouter();
    await renderManager();

    expect(screen.queryByText("Switch Computer")).toBeNull();
    const heading = await screen.findByRole("heading", { name: "Choose your computer", level: 1 });
    expect(heading.parentElement?.className).toContain("text-center");
    expect(heading.className).not.toContain("uppercase");
    expect(heading.className).toContain("tracking-[-0.055em]");
    expect(heading.className).toContain("font-medium");
    expect(heading.className).toContain("bg-clip-text");
    expect(heading.className).toContain("text-transparent");
    expect(heading.className).toContain("leading-[1.08]");
    expect(heading.className).toContain("pb-[0.12em]");
    expect(heading.className).toContain("block");
    expect(heading.className).toContain("mx-auto");
    expect(heading.style.backgroundImage).toBe(
      "linear-gradient(90deg, rgb(47, 57, 44) 0%, rgb(47, 57, 44) 24%, rgb(196, 162, 101) 50%, rgb(47, 57, 44) 76%, rgb(47, 57, 44) 100%)",
    );
    expect(heading.style.backgroundSize).toBe("300% 100%");
    expect(heading.className).toContain("onboard-shimmer");
    expect(heading.className).toContain("onboard-glow");
    expect(heading.className).toContain("motion-reduce:animate-none");
    const shellBackdrop = screen.getByTestId("runtime-shell-backdrop");
    expect(shellBackdrop.getAttribute("src")).toContain("runtime-shell-backdrop.webp");
    expect(shellBackdrop.className).toContain("blur-[18px]");
    const rabbitShadow = screen.getByTestId("runtime-rabbit-shadow");
    expect(rabbitShadow.className).toContain("left-1/2");
    expect(rabbitShadow.className).toContain("top-1/2");
    expect(rabbitShadow.className).toContain("w-[min(156vw,68rem)]");
    const brandLockup = screen.getByRole("link", { name: "Matrix OS home" });
    expect(brandLockup.className).toContain("justify-center");
    expect(brandLockup.className).toContain("mx-auto");
    expect(screen.getByRole("img", { name: "Matrix OS logo" })).toBeTruthy();
    const wordmark = screen.getByText("Matrix OS");
    expect(screen.queryByText("MATRIX OS")).toBeNull();
    expect(wordmark.className).toContain("inline-flex");
    expect(wordmark.className).toContain("h-9");
    expect(wordmark.className).toContain("items-center");
    expect(wordmark.className).toContain("leading-none");
    expect(wordmark.style.fontFamily).toBe("var(--font-orbitron), Orbitron, sans-serif");
    expect(wordmark.style.color).toBe("rgb(50, 53, 46)");
    expect(screen.queryByText("Each one is a private Matrix OS workspace with its own files and data.")).toBeNull();
    expect(screen.getByText("Matrix OS member").className).toContain("font-medium");
    expect(screen.getByText("neo@example.com")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Switch to Studio/i }).getAttribute("href")).toBe(
      "/vm/neo-studio?runtime=studio",
    );
    expect(screen.getByText("Current")).toBeTruthy();
    expect(screen.getByText("🐇")).toBeTruthy();
    expect(screen.getByText("🧪")).toBeTruthy();
    expect(screen.getByText(/Preview Computer/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Get another computer" })).toBeTruthy();
    expect(screen.getByText("Studio").className).toContain("font-medium");
    const manageAccount = screen.getByRole("button", { name: "Manage account" });
    const signOut = screen.getByRole("button", { name: "Sign out" });
    expect(manageAccount.className).toContain("size-9");
    expect(signOut.className).toContain("size-9");
    expect(screen.queryByText("Manage account")).toBeNull();
    expect(screen.queryByText("Sign out")).toBeNull();
    expect(screen.getByLabelText("Matrix OS computers").className).toContain("justify-center");
    expect(screen.getByLabelText("Account").className).toMatch(/fixed/);
    expect(screen.getByLabelText("Account").className).toMatch(/w-fit/);
    expect(screen.getByRole("main").className).toMatch(/overflow-y-auto/);
    expect(screen.getByRole("main").className).toContain("font-sans");
  });

  it("leaves runtime management for the dedicated computer onboarding route", async () => {
    const navigate = vi.fn();
    installFetchRouter();
    await renderManager({ onInternalNavigate: navigate });

    fireEvent.click(await screen.findByRole("button", { name: "Get another computer" }));

    expect(navigate).toHaveBeenCalledWith("/?billing=setup&handoff=add-computer");
    expect(screen.queryByRole("textbox", { name: "Computer name" })).toBeNull();
  });

  it("starts the existing computer setup process on the dedicated onboarding surface", async () => {
    installFetchRouter();
    await renderOnboarding();

    expect(await screen.findByRole("textbox", { name: "Computer name" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Choose your computer" })).toBeNull();
  });

  it("redirects legacy runtime new-computer links to the dedicated onboarding route", async () => {
    const navigate = vi.fn();
    window.history.replaceState({}, "", "/runtime?new=1");
    installFetchRouter();
    await renderManager({ onInternalNavigate: navigate });

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/?billing=setup&handoff=add-computer"));
  });

  it("redirects a legacy new-computer link only once when the navigation callback changes", async () => {
    const firstNavigate = vi.fn();
    const secondNavigate = vi.fn();
    window.history.replaceState({}, "", "/runtime?new=1");
    installFetchRouter();
    const { RuntimeManager } = await import("../../shell/src/components/runtime/RuntimeManager.js");
    const view = render(<RuntimeManager onInternalNavigate={firstNavigate} />);
    await waitFor(() => expect(firstNavigate).toHaveBeenCalledTimes(1));

    view.rerender(<RuntimeManager onInternalNavigate={secondNavigate} />);

    expect(firstNavigate).toHaveBeenCalledTimes(1);
    expect(secondNavigate).not.toHaveBeenCalled();
  });

  it("hands signed-out visitors to Clerk authentication", async () => {
    clerkState.isSignedIn = false;

    await renderOnboarding();

    expect(screen.getByText("Redirecting to sign in")).toBeTruthy();
  });

  it("keeps naming errors in the naming step and previews the normalized slot", async () => {
    installFetchRouter();
    await renderOnboarding();

    const input = await screen.findByRole("textbox", { name: "Computer name" });
    fireEvent.change(input, { target: { value: "Primary" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert").textContent).toMatch(/reserved/i);

    fireEvent.change(input, { target: { value: "New Design Studio" } });
    expect(screen.getByText("new-design-studio")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Pick the cloud computer Matrix boots on" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change computer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change region" })).toBeTruthy();
  });

  it("reuses first-time strength, region, interval, and Checkout for another computer", async () => {
    const navigate = vi.fn();
    const fetchMock = installFetchRouter({ billing: billingStatus(3) });
    await renderOnboarding({ onExternalNavigate: navigate });

    fireEvent.change(await screen.findByRole("textbox", { name: "Computer name" }), {
      target: { value: "Research Lab" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Pick the cloud computer Matrix boots on" })).toBeTruthy();
    expect(screen.getByText("Settings")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Billing" })).toBeTruthy();
    expect(screen.getByText("New subscription")).toBeTruthy();
    expect(screen.queryByText("Active")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change computer" }));
    expect(screen.getByRole("button", { name: /Max.*CPX52/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Starter.*CPX22/i }));
    fireEvent.click(screen.getByRole("button", { name: "Change region" }));
    fireEvent.click(screen.getByRole("button", { name: /US West.*hil/i }));
    fireEvent.click(screen.getByRole("button", { name: "Annual" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to pay" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/billing/checkout",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            planSlug: "matrix_starter",
            interval: "annual",
            regionSlug: "region_hil",
            runtimeSlot: "research-lab",
            returnPath: "/?billing=setup&handoff=add-computer",
          }),
        }),
      );
      expect(navigate).toHaveBeenCalledWith("https://checkout.stripe.test/session");
    });
    expect(fetchMock).not.toHaveBeenCalledWith("/api/auth/provision-runtime", expect.anything());
  });

  it("does not open Checkout when the additional-computer setup cannot be saved", async () => {
    const navigate = vi.fn();
    const fetchMock = installFetchRouter();
    await renderOnboarding({ onExternalNavigate: navigate });
    fireEvent.change(await screen.findByRole("textbox", { name: "Computer name" }), {
      target: { value: "Research Lab" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("storage unavailable", "SecurityError");
    });

    fireEvent.click(await screen.findByRole("button", { name: "Continue to pay" }));

    expect(await screen.findByRole("heading", { name: "Computer setup paused" })).toBeTruthy();
    expect(screen.getByText(/could not safely save/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalledWith("/billing/checkout", expect.anything());
    expect(navigate).not.toHaveBeenCalled();
  });

  it("waits for inventory before showing the naming step so duplicate validation cannot be bypassed", async () => {
    let resolveInventory!: (response: Response) => void;
    const inventoryResponse = new Promise<Response>((resolve) => {
      resolveInventory = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/auth/computers") return inventoryResponse;
      if (url.startsWith("/billing/status")) return json(billingStatus(3));
      throw new Error(`Unhandled test request: ${url}`);
    });
    await renderOnboarding();

    expect(screen.getByText("Loading your computers")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Computer name" })).toBeNull();
    await act(async () => resolveInventory(json(inventory)));
    const input = await screen.findByRole("textbox", { name: "Computer name" });
    fireEvent.change(input, { target: { value: "Studio" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByRole("alert").textContent).toMatch(/already uses/i);
    expect(screen.queryByRole("heading", { name: "Pick the cloud computer Matrix boots on" })).toBeNull();
  });

  it("recovers when the dedicated onboarding surface cannot load inventory", async () => {
    let inventoryReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/auth/computers") {
        inventoryReads += 1;
        if (inventoryReads === 1) throw new Error("inventory unavailable");
        return json(inventory);
      }
      if (url.startsWith("/billing/status")) return json(billingStatus(3));
      throw new Error(`Unhandled test request: ${url}`);
    });
    await renderOnboarding();

    expect(await screen.findByRole("heading", { name: "Computer setup paused" })).toBeTruthy();
    expect(screen.getByText("Your computer setup could not be loaded. Try again in a moment.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Computer name" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("textbox", { name: "Computer name" })).toBeTruthy();
    expect(inventoryReads).toBe(2);
  });

  it("lets an internal override bypass Checkout and starts provisioning", async () => {
    const fetchMock = installFetchRouter({ billing: billingStatus(3, "override") });
    await renderOnboarding();
    fireEvent.change(await screen.findByRole("textbox", { name: "Computer name" }), {
      target: { value: "Research Lab" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Change computer" }));
    expect(screen.queryByRole("button", { name: /Max.*CPX52/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue setup" }));

    fireEvent.click(screen.getByRole("button", { name: "Install & build" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/provision-runtime",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            runtime: "research-lab",
            developerTools: ["codex", "claude-code", "opencode", "pi"],
            serverType: "cpx32",
            location: "fsn1",
          }),
        }),
      );
    });
    expect(await screen.findByRole("heading", { name: "Building Research Lab" })).toBeTruthy();
    expect(await screen.findByText(/Booting/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalledWith("/billing/checkout", expect.anything());
  });

  it("retries Stripe Checkout in place without provisioning after a failure", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let checkoutAttempts = 0;
    const fetchMock = installFetchRouter({
      billing: billingStatus(2),
      checkout: () => {
        checkoutAttempts += 1;
        return checkoutAttempts === 1
          ? json({ error: "raw Stripe failure" }, 503)
          : json({ url: "https://checkout.stripe.test/retry" });
      },
    });
    const navigate = vi.fn();
    await renderOnboarding({ onExternalNavigate: navigate });
    await beginNamedComputer("Research Lab");

    expect((await screen.findByText(/Checkout is unavailable/i)).textContent).not.toMatch(/raw Stripe/i);
    now.mockReturnValue(121_001);
    fireEvent.click(screen.getByRole("button", { name: "Continue to pay" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://checkout.stripe.test/retry"));
    expect(JSON.parse(window.sessionStorage.getItem("matrix:add-computer-draft:v1") ?? "null")).toMatchObject({
      createdAt: 121_001,
    });
    expect(fetchMock.mock.calls.filter(([url]) => url === "/billing/checkout")).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalledWith("/api/auth/provision-runtime", expect.anything());
  });

  it("shows retryable slot progress failures without leaking raw server errors", async () => {
    const fetchMock = installFetchRouter({
      billing: billingStatus(3, "override"),
      provision: json({ error: "Hetzner raw database /var/lib secret", code: "provider_unavailable" }, 503),
    });
    await renderOnboarding();
    await beginNamedComputer("Research Lab");
    fireEvent.click(screen.getByRole("button", { name: "Install & build" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not start building/i);
    expect(alert.textContent).not.toMatch(/Hetzner|database|\/var\/lib/i);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => url === "/api/auth/provision-runtime")).toHaveLength(2);
    });
  });

  it("retries a failed slot build through the journey contract", async () => {
    const fetchMock = installFetchRouter({
      billing: billingStatus(3, "override"),
      journey: {
        phase: "provisioning_failed",
        detail: "Hetzner database /var/lib provider failure",
        failure: { retryable: true, attempt: 1 },
      },
    });
    await renderOnboarding();
    await beginNamedComputer("Research Lab");
    fireEvent.click(screen.getByRole("button", { name: "Install & build" }));

    const retryButton = await screen.findByRole("button", { name: "Retry build" });
    expect(document.body.textContent).not.toMatch(/Hetzner|database|\/var\/lib|provider/i);
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/journey/retry-provision",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ runtimeSlot: "research-lab" }),
        }),
      );
    });
  });

  it("lets users return to their computers after a non-retryable slot build failure", async () => {
    const navigate = vi.fn();
    installFetchRouter({
      billing: billingStatus(3, "override"),
      journey: {
        phase: "provisioning_failed",
        detail: "raw provider failure",
        failure: { retryable: false, attempt: 1 },
      },
    });
    await renderOnboarding({ onInternalNavigate: navigate });
    await beginNamedComputer("Research Lab");
    fireEvent.click(screen.getByRole("button", { name: "Install & build" }));

    const backButton = await screen.findByRole("button", { name: "Back to computers" });
    expect(screen.queryByRole("button", { name: "Retry build" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/raw provider failure/i);
    fireEvent.click(backButton);

    expect(navigate).toHaveBeenCalledWith("/runtime");
    expect(window.sessionStorage.getItem("matrix:add-computer-draft:v1")).toBeNull();
  });

  it("keeps polling after a malformed journey projection", async () => {
    let journeyReads = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/auth/computers") return json(inventory);
      if (url.startsWith("/billing/status")) return json(billingStatus(3, "override"));
      if (url === "/api/auth/provision-runtime") return json({ status: "provisioning" }, 202);
      if (url.startsWith("/api/journey?runtimeSlot=")) {
        journeyReads += 1;
        return journeyReads === 1
          ? json({ phase: "provisioning", progress: { stage: "provider-secret", startedAt: "now" } })
          : json({
              phase: "provisioning",
              detail: "Building",
              progress: { stage: "booting", startedAt: "2026-07-18T00:00:00.000Z" },
            });
      }
      throw new Error(`Unhandled test request: ${url}`);
    });
    await renderOnboarding({ journeyPollIntervalMs: 10 });
    await beginNamedComputer("Research Lab");
    fireEvent.click(screen.getByRole("button", { name: "Install & build" }));

    expect(await screen.findByText(/Booting/i)).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/journey?runtimeSlot="))).toHaveLength(2);
    expect(document.body.textContent).not.toContain("provider-secret");
  });

  it("opens a completed second computer using its refreshed authoritative gateway path", async () => {
    let inventoryReads = 0;
    const completedComputer = {
      handle: "machine-73fd",
      runtimeSlot: "research-lab",
      label: "Additional Computer",
      availability: "available",
      kind: "customer",
      versionLabel: "v2026.07.18",
      gatewayPath: "/vm/machine-73fd?runtime=research-lab",
      capabilities: ["matrixComputerInventoryV1"],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/auth/computers") {
        inventoryReads += 1;
        return json(inventoryReads > 1 ? { ...inventory, items: [...inventory.items, completedComputer] } : inventory);
      }
      if (url.startsWith("/billing/status")) return json(billingStatus(4, "override"));
      if (url === "/api/auth/provision-runtime") return json({ status: "provisioning" }, 202);
      if (url.startsWith("/api/journey?runtimeSlot=")) {
        return json({ phase: "ready", detail: "Ready", nextAction: { kind: "open_shell" } });
      }
      throw new Error(`Unhandled test request: ${url}`);
    });
    await renderOnboarding({ journeyPollIntervalMs: 10 });
    await beginNamedComputer("Research Lab");
    fireEvent.click(screen.getByRole("button", { name: "Install & build" }));

    const openLink = await screen.findByRole("link", { name: "Open computer" });
    expect(openLink.getAttribute("href")).toBe("/vm/machine-73fd?runtime=research-lab");
  });

  it("ends billing wait safely when the projection does not change by the deadline", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    window.sessionStorage.setItem("matrix:add-computer-draft:v1", JSON.stringify({
      name: "Research Lab",
      slot: "research-lab",
      developerTools: ["codex"],
      serverType: "cpx32",
      location: "fsn1",
      createdAt: 1_000,
    }));
    let billingReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/auth/computers") return json(inventory);
      if (url === "/billing/status") return json(billingStatus(2));
      if (url.startsWith("/billing/status?runtimeSlot=")) {
        billingReads += 1;
        return json({ entitlement: null, access: { runtimeProxyAllowed: false, reason: "missing" } });
      }
      throw new Error(`Unhandled test request: ${url}`);
    });

    await renderOnboarding(
      { billingPollIntervalMs: 10 },
      "/?billing=success&handoff=add-computer",
    );
    expect(await screen.findByRole("heading", { name: "Activating your computer subscription" })).toBeTruthy();
    await waitFor(() => expect(billingReads).toBeGreaterThanOrEqual(2));
    now.mockReturnValue(121_001);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/taking longer than expected/i);
  });

  it("resumes only after the signed billing projection activates the exact runtime slot", async () => {
    window.sessionStorage.setItem("matrix:add-computer-draft:v1", JSON.stringify({
      name: "Research Lab",
      slot: "research-lab",
      developerTools: ["codex"],
      serverType: "cpx32",
      location: "fsn1",
      createdAt: Date.now(),
    }));
    let billingReads = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/auth/computers") return json(inventory);
      if (url === "/billing/status") return json(billingStatus(2));
      if (url.startsWith("/billing/status?runtimeSlot=")) {
        billingReads += 1;
        return billingReads > 1
          ? json(billingStatus(1))
          : json({ entitlement: null, access: { runtimeProxyAllowed: false, reason: "missing" } });
      }
      if (url === "/api/auth/provision-runtime") return json({ status: "provisioning" }, 202);
      if (url.startsWith("/api/journey?runtimeSlot=")) {
        return json({ phase: "provisioning", detail: "Building", nextAction: { kind: "wait" } });
      }
      throw new Error(`Unhandled test request: ${url}`);
    });

    await renderOnboarding(
      { billingPollIntervalMs: 10 },
      "/?billing=success&handoff=add-computer",
    );
    expect(await screen.findByRole("heading", { name: "Activating your computer subscription" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Preinstall coding agents?" })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/auth/provision-runtime", expect.anything());

    fireEvent.click(screen.getByRole("button", { name: "Install & build" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/provision-runtime",
      expect.objectContaining({
        body: JSON.stringify({
          runtime: "research-lab",
          developerTools: ["codex", "claude-code", "opencode", "pi"],
          serverType: "cpx32",
          location: "fsn1",
        }),
      }),
    ));
  });

  it("returns a canceled checkout to the saved plan selection without polling activation", async () => {
    window.sessionStorage.setItem("matrix:add-computer-draft:v1", JSON.stringify({
      name: "Research Lab",
      slot: "research-lab",
      developerTools: [],
      serverType: "cpx32",
      location: "fsn1",
      createdAt: Date.now(),
    }));
    const fetchMock = installFetchRouter();

    await renderOnboarding({}, "/?billing=canceled&handoff=add-computer");

    expect(await screen.findByRole("heading", { name: "Pick the cloud computer Matrix boots on" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Activating your computer subscription" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("runtimeSlot=research-lab"));
  });
});
