// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clerkState = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: true,
  getToken: vi.fn(async () => "clerk-token"),
}));
const onboardingNavigation = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({
    isLoaded: clerkState.isLoaded,
    isSignedIn: clerkState.isSignedIn,
    getToken: clerkState.getToken,
  }),
  RedirectToSignIn: () => <div data-testid="redirect-to-sign-in">redirecting to sign in</div>,
}));

vi.mock("@/lib/onboarding-navigation", () => ({
  navigateForOnboarding: onboardingNavigation.navigate,
}));

vi.mock("@/components/UserButton", () => ({
  UserButton: () => <button type="button">Account menu</button>,
}));

import { BootSequence } from "../../shell/src/components/BootSequence";
import type { JourneyState } from "../../shell/src/hooks/useJourney";

function mockJourney(state: JourneyState, journeyStatus = 200) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/journey")) {
      return new Response(JSON.stringify(state), { status: journeyStatus, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ status: "started" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const baseState: JourneyState = {
  phase: "plan_required",
  detail: "Choose a plan to create your Matrix computer.",
  nextAction: { kind: "open_plans", url: "https://app.matrix-os.com/?plans=1" },
};

describe("BootSequence", () => {
  beforeEach(() => {
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    onboardingNavigation.navigate.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders children immediately when a platform session is already verified", () => {
    mockJourney(baseState);
    render(
      <BootSequence platformSessionActive>
        <div data-testid="shell">SHELL</div>
      </BootSequence>,
    );
    expect(screen.getByTestId("shell")).toBeTruthy();
  });

  it("renders children under the e2e bypass", () => {
    mockJourney(baseState);
    render(
      <BootSequence e2eBypass>
        <div data-testid="shell">SHELL</div>
      </BootSequence>,
    );
    expect(screen.getByTestId("shell")).toBeTruthy();
  });

  it("shows the plan step for plan_required", async () => {
    mockJourney(baseState);
    render(<BootSequence><div data-testid="shell">SHELL</div></BootSequence>);
    expect(await screen.findByText("Choose your plan")).toBeTruthy();
    const link = screen.getByText("View plans") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain("plans=1");
    expect(screen.queryByTestId("shell")).toBeNull();
  });

  it("shows a calm settling state within the window (never the paywall)", async () => {
    mockJourney({
      phase: "payment_settling",
      detail: "Activating your subscription…",
      nextAction: { kind: "wait" },
      settling: { since: "2026-06-11T12:00:00.000Z", delayed: false },
    });
    render(<BootSequence><div data-testid="shell">SHELL</div></BootSequence>);
    expect(await screen.findByText("Activating your subscription")).toBeTruthy();
    expect(screen.queryByText("Choose your plan")).toBeNull();
  });

  it("escalates to support when settling is delayed", async () => {
    mockJourney({
      phase: "payment_settling",
      detail: "Your payment is taking longer than expected to confirm.",
      nextAction: { kind: "contact_support" },
      settling: { since: "2026-06-11T11:00:00.000Z", delayed: true },
    });
    render(<BootSequence><div data-testid="shell">SHELL</div></BootSequence>);
    expect(await screen.findByText("Taking longer than expected")).toBeTruthy();
    expect(screen.getByText("Contact support")).toBeTruthy();
  });

  it("shows build progress with a stage label during provisioning", async () => {
    mockJourney({
      phase: "provisioning",
      detail: "Building your Matrix computer…",
      nextAction: { kind: "wait" },
      progress: { stage: "booting", startedAt: "2026-06-11T12:00:00.000Z" },
    });
    render(<BootSequence><div data-testid="shell">SHELL</div></BootSequence>);
    expect(await screen.findByText("Building your Matrix computer")).toBeTruthy();
    expect(screen.getByText("Booting your computer")).toBeTruthy();
  });

  it("shows Settings-style default installs and immediately exchanges the app session after a 202", async () => {
    const journeyState: JourneyState = {
      phase: "install_choices_required",
      detail: "Choose default installs before building your Matrix computer.",
      nextAction: { kind: "choose_default_installs" },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/journey")) {
        return new Response(JSON.stringify(journeyState), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "/api/auth/provision-runtime") {
        return new Response("{}", { status: 202, headers: { "content-type": "application/json" } });
      }
      if (url === "/api/auth/app-session") {
        return new Response(JSON.stringify({ redirectTo: "/" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const timeoutSpy = vi.spyOn(window, "setTimeout");

    render(<BootSequence><div data-testid="shell">SHELL</div></BootSequence>);

    expect((await screen.findByRole("button", { name: "Default installs" })).getAttribute("aria-current")).toBe("page");
    for (const label of ["Codex", "Claude Code", "OpenCode", "Pi"]) {
      expect(screen.getByRole("checkbox", { name: label })).toHaveProperty("checked", true);
    }
    fireEvent.click(screen.getByRole("checkbox", { name: "OpenCode" }));
    timeoutSpy.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Build VPS" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/provision-runtime",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ developerTools: ["codex", "claude-code", "pi"] }),
        }),
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/app-session",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ redirectTo: "/" }) }),
    );
    expect(onboardingNavigation.navigate).toHaveBeenCalledWith("/");
    expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 8_000)).toBe(false);
    expect(screen.queryByText(/Starting|Preparing|Loading your Matrix computer/i)).toBeNull();
  });

  it("accepts only a recognized provisioning conflict before the immediate session handoff", async () => {
    const journeyState: JourneyState = {
      phase: "install_choices_required",
      detail: "Choose default installs before building your Matrix computer.",
      nextAction: { kind: "choose_default_installs" },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/journey")) {
        return new Response(JSON.stringify(journeyState), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "/api/auth/provision-runtime") {
        return new Response(JSON.stringify({ code: "provisioning_conflict" }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ redirectTo: "/" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<BootSequence><div data-testid="shell">SHELL</div></BootSequence>);
    fireEvent.click(await screen.findByRole("button", { name: "Build VPS" }));

    await waitFor(() => expect(onboardingNavigation.navigate).toHaveBeenCalledWith("/"));
  });

  it("stays on the chooser with the approved retry error when session exchange fails", async () => {
    const journeyState: JourneyState = {
      phase: "install_choices_required",
      detail: "Choose default installs before building your Matrix computer.",
      nextAction: { kind: "choose_default_installs" },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/journey")) {
        return new Response(JSON.stringify(journeyState), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "/api/auth/provision-runtime") {
        return new Response("{}", { status: 202, headers: { "content-type": "application/json" } });
      }
      return new Response("upstream provider secret", { status: 503 });
    }));

    render(<BootSequence><div data-testid="shell">SHELL</div></BootSequence>);
    fireEvent.click(await screen.findByRole("button", { name: "Build VPS" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Matrix could not start building this VPS. Try again.");
    expect((screen.getByRole("button", { name: "Build VPS" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText("upstream provider secret")).toBeNull();
    expect(onboardingNavigation.navigate).not.toHaveBeenCalled();
  });

  it("offers retry on a retryable failure and calls retry-provision", async () => {
    const fetchMock = mockJourney({
      phase: "provisioning_failed",
      detail: "Setting up your computer ran into a problem.",
      nextAction: { kind: "retry_provision" },
      failure: { retryable: true, attempt: 1 },
    });
    render(<BootSequence><div data-testid="shell">SHELL</div></BootSequence>);
    const retry = await screen.findByText("Retry setup");
    fireEvent.click(retry);
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/api/journey/retry-provision"))).toBe(true);
    });
  });

  it("shows support (no retry) once retries are exhausted", async () => {
    mockJourney({
      phase: "provisioning_failed",
      detail: "We could not set up your computer after several attempts.",
      nextAction: { kind: "contact_support" },
      failure: { retryable: false, attempt: 3 },
    });
    render(<BootSequence><div data-testid="shell">SHELL</div></BootSequence>);
    expect(await screen.findByText("Setup needs attention")).toBeTruthy();
    expect(screen.getByText("Contact support")).toBeTruthy();
    expect(screen.queryByText("Retry setup")).toBeNull();
  });

  it("hands off to the shell on first_run (Desktop owns first-run UI)", async () => {
    mockJourney({ phase: "first_run", detail: "Finish setting up.", nextAction: { kind: "begin_first_run" } });
    render(<BootSequence><div data-testid="shell">SHELL</div></BootSequence>);
    expect(await screen.findByTestId("shell")).toBeTruthy();
  });

  it("renders the shell when ready", async () => {
    mockJourney({ phase: "ready", detail: "Your Matrix computer is ready.", nextAction: { kind: "open_shell", url: "https://app.matrix-os.com/" } });
    render(<BootSequence><div data-testid="shell">SHELL</div></BootSequence>);
    expect(await screen.findByTestId("shell")).toBeTruthy();
  });

  it("shows an unreachable state on a 503 (never guesses a phase)", async () => {
    mockJourney(baseState, 503);
    render(<BootSequence><div data-testid="shell">SHELL</div></BootSequence>);
    expect(await screen.findByText("We can’t reach Matrix right now.")).toBeTruthy();
    expect(screen.queryByTestId("shell")).toBeNull();
  });

  it("re-authenticates (does not loop) when the journey returns 401", async () => {
    const fetchMock = mockJourney(baseState, 401);
    render(<BootSequence><div data-testid="shell">SHELL</div></BootSequence>);
    expect(await screen.findByTestId("redirect-to-sign-in")).toBeTruthy();
    // Stops polling under persistent auth failure: exactly one journey fetch.
    const journeyCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/journey"));
    expect(journeyCalls).toHaveLength(1);
  });

  it("redirects a signed-out user to sign-in instead of spinning forever", async () => {
    clerkState.isSignedIn = false;
    mockJourney(baseState);
    render(<BootSequence><div data-testid="shell">SHELL</div></BootSequence>);
    expect(await screen.findByTestId("redirect-to-sign-in")).toBeTruthy();
    expect(screen.queryByTestId("shell")).toBeNull();
  });

  it("keeps a signed-in account_required phase out of the Clerk redirect loop", async () => {
    mockJourney({ phase: "account_required", detail: "Create your account.", nextAction: { kind: "none" } });
    render(<BootSequence><div data-testid="shell">SHELL</div></BootSequence>);
    expect(await screen.findByText("Finishing account setup")).toBeTruthy();
    expect(screen.getByText("Try again")).toBeTruthy();
    expect(screen.getByText("Contact support")).toBeTruthy();
    expect(screen.queryByTestId("redirect-to-sign-in")).toBeNull();
    expect(screen.queryByTestId("shell")).toBeNull();
  });
});
