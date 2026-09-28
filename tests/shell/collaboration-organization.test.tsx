// @vitest-environment jsdom

import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clerkState = vi.hoisted(() => ({
  isLoaded: true,
  organization: null as { id: string } | null,
  userId: "user_owner" as string | null,
  useOrganization: vi.fn(),
}));
vi.mock("@clerk/nextjs", () => ({
  useOrganization: () => {
    clerkState.useOrganization();
    return clerkState.isLoaded
      ? { isLoaded: true, organization: clerkState.organization }
      : { isLoaded: false, organization: undefined };
  },
  useAuth: () => ({ isLoaded: clerkState.isLoaded, userId: clerkState.isLoaded ? clerkState.userId : undefined }),
}));

import { CollaborationOrganization } from "../../shell/src/lib/collaboration-organization.js";

const fetchMock = vi.fn<typeof fetch>();

function listing(organizations: Array<Record<string, unknown>>): Response {
  return new Response(JSON.stringify({ organizations }), { status: 200, headers: { "content-type": "application/json" } });
}

function StatefulChild({ organizationId }: { organizationId: string | null }) {
  // Stands in for a share flow holding organization-bound state (a preflight token, an open scope).
  const [token, setToken] = useState<string | null>(null);
  return <div>
    <span data-testid="organization">{organizationId ?? "none"}</span>
    <span data-testid="token">{token ?? "none"}</span>
    <button type="button" onClick={() => setToken(`preflight-for-${organizationId ?? "none"}`)}>preflight</button>
  </div>;
}

const gate = () => <CollaborationOrganization>{(id) => <StatefulChild organizationId={id} />}</CollaborationOrganization>;

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe("CollaborationOrganization gate", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    clerkState.isLoaded = true;
    clerkState.organization = null;
    clerkState.userId = "user_owner";
    clerkState.useOrganization.mockClear();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("remounts the sharing subtree when the active organization changes so no organization-bound state survives", async () => {
    fetchMock.mockResolvedValue(listing([]));
    clerkState.organization = { id: "org_alpha" };
    const { rerender } = render(gate());
    fireEvent.click(screen.getByRole("button", { name: "preflight" }));
    expect(screen.getByTestId("token")).toHaveTextContent("preflight-for-org_alpha");

    clerkState.organization = { id: "org_beta" };
    act(() => rerender(gate()));
    expect(screen.getByTestId("organization")).toHaveTextContent("org_beta");
    expect(screen.getByTestId("token")).toHaveTextContent("none");

    clerkState.organization = null;
    act(() => rerender(gate()));
    await settle();
    expect(screen.getByTestId("organization")).toHaveTextContent("none");
  });

  it("uses Clerk's active organization without asking the platform", async () => {
    clerkState.organization = { id: "org_alpha" };
    render(gate());
    await settle();
    expect(screen.getByTestId("organization")).toHaveTextContent("org_alpha");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits for Clerk to load before asking the platform and renders no organization meanwhile", async () => {
    clerkState.isLoaded = false;
    render(gate());
    await settle();
    expect(screen.getByTestId("organization")).toHaveTextContent("none");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the only verified membership when Clerk has no active organization", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockResolvedValue(listing([{ organizationId: "org_alpha", name: "Alpha", role: "member" }]));
    render(gate());
    expect(screen.getByTestId("organization")).toHaveTextContent("none");
    fireEvent.click(screen.getByRole("button", { name: "preflight" }));

    await waitFor(() => expect(screen.getByTestId("organization")).toHaveTextContent("org_alpha"));
    // The subtree remounts: nothing prepared without an organization carries into it.
    expect(screen.getByTestId("token")).toHaveTextContent("none");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${window.location.origin}/api/organizations`);
    expect(init).toMatchObject({ method: "GET", credentials: "same-origin", redirect: "error" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it("renders no organization when the account has several memberships", async () => {
    fetchMock.mockResolvedValue(listing([{ organizationId: "org_alpha" }, { organizationId: "org_beta" }]));
    render(gate());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await settle();
    expect(screen.getByTestId("organization")).toHaveTextContent("none");
  });

  it.each([
    ["an error status", () => new Response(JSON.stringify({ error: "Organizations unavailable" }), { status: 503, headers: { "content-type": "application/json" } })],
    ["a non-JSON body", () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })],
    ["malformed JSON", () => new Response("{", { status: 200, headers: { "content-type": "application/json" } })],
    ["an invalid listing", () => listing([{ organizationId: "user_alpha" }])],
    ["an oversized body", () => new Response(JSON.stringify({ organizations: [{ organizationId: "org_alpha", name: "x".repeat(70_000) }] }), {
      status: 200, headers: { "content-type": "application/json" },
    })],
  ])("renders no organization and logs a generic warning for %s", async (_label, response) => {
    fetchMock.mockResolvedValue(response());
    render(gate());
    await waitFor(() => expect(console.warn).toHaveBeenCalledWith("[collaboration-organization] organization listing unavailable", expect.any(String)));
    expect(screen.getByTestId("organization")).toHaveTextContent("none");
  });

  it("renders no organization when the request fails", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }));
    render(gate());
    await waitFor(() => expect(console.warn).toHaveBeenCalledWith("[collaboration-organization] organization listing unavailable", "TimeoutError"));
    expect(screen.getByTestId("organization")).toHaveTextContent("none");
  });

  it("shares one in-flight listing request between Share controls mounted together", async () => {
    let respond: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => { respond = resolve; }));
    render(<>{gate()}{gate()}</>);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { respond(listing([{ organizationId: "org_alpha" }])); });
    await waitFor(() => expect(screen.getAllByTestId("organization").map((node) => node.textContent)).toEqual(["org_alpha", "org_alpha"]));
  });

  it("does not hand another account's listing to a different signed-in user", async () => {
    let respond: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { respond = resolve; }));
    fetchMock.mockResolvedValueOnce(listing([{ organizationId: "org_beta" }]));
    const { rerender } = render(gate());
    await settle();
    clerkState.userId = "user_other";
    act(() => rerender(gate()));
    await act(async () => { respond(listing([{ organizationId: "org_alpha" }])); });
    await waitFor(() => expect(screen.getByTestId("organization")).toHaveTextContent("org_beta"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the E2E bypass free of Clerk and the platform", async () => {
    vi.stubEnv("NEXT_PUBLIC_E2E_TEST_BYPASS", "1");
    vi.resetModules();
    const { CollaborationOrganization: BypassGate } = await import("../../shell/src/lib/collaboration-organization.js");
    render(<BypassGate>{(id) => <StatefulChild organizationId={id} />}</BypassGate>);
    await settle();
    expect(screen.getByTestId("organization")).toHaveTextContent("none");
    expect(clerkState.useOrganization).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
