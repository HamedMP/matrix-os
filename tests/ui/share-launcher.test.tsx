// @vitest-environment jsdom
import React, { useState } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedAppBadge } from "../../packages/ui/src/collaboration/SharedAppBadge";
import {
  LauncherFilterChips, effectiveLauncherFilter, launcherFilterChips, launcherFilterHint, matchesLauncherFilter, organizationColor,
  useSeenSharedApps, type LauncherFilter,
} from "../../packages/ui/src/share/index";

// Outcome: members find org-shared apps in the launcher (org badge, new dot,
// org filter chips). Faults: chips for orgs without shared apps, wrong counts,
// a stale org filter hiding everything, every existing app marked new on
// rollout, or a lost "seen" write blocking the app from opening.

const finna = { organizationId: "org_finna", name: "Finna", memberCount: 24 };
const acme = { organizationId: "org_acme", name: "Acme Ventures", memberCount: 112 };
const northwind = { organizationId: "org_northwind", name: "Northwind Studio", memberCount: 8 };
const entries = [
  { name: "Chat", organizationId: null, mine: false },
  { name: "Chess", organizationId: null, mine: true },
  { name: "Sales CRM", organizationId: "org_finna", mine: false },
  { name: "Hiring pipeline", organizationId: "org_finna", mine: false },
  { name: "Deal room", organizationId: "org_acme", mine: false },
];

afterEach(cleanup);

describe("launcher filters", () => {
  it("offers All apps, Mine, and one chip per org that has shared apps", () => {
    const chips = launcherFilterChips(entries, [finna, acme, northwind]);
    expect(chips.map((chip) => [chip.label, chip.count])).toEqual([["All apps", undefined], ["Mine", undefined], ["Finna", 2], ["Acme Ventures", 1]]);
    expect(entries.filter((entry) => matchesLauncherFilter(entry, "mine")).map((entry) => entry.name)).toEqual(["Chess"]);
    expect(entries.filter((entry) => matchesLauncherFilter(entry, "org:org_finna")).map((entry) => entry.name)).toEqual(["Sales CRM", "Hiring pipeline"]);
    expect(launcherFilterHint("org:org_finna", 2, chips, "all")).toBe("2 apps shared in Finna.");
    expect(launcherFilterHint("mine", 1, chips, "all")).toBe("Apps you made.");
    expect(effectiveLauncherFilter("org:org_northwind", chips)).toBe("all");
  });

  it("renders pressed-state chips with the org initial and count", () => {
    function Harness() {
      const [value, setValue] = useState<LauncherFilter>("all");
      return <LauncherFilterChips chips={launcherFilterChips(entries, [finna, acme])} value={value} onChange={setValue} />;
    }
    render(<Harness />);
    expect(screen.getByRole("group", { name: "Filter apps" })).toBeTruthy();
    const finnaChip = screen.getByRole("button", { name: /Finna/ });
    expect(finnaChip.getAttribute("aria-pressed")).toBe("false");
    expect(finnaChip.textContent).toBe("FFinna2");
    fireEvent.click(finnaChip);
    expect(finnaChip.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "All apps" }).getAttribute("aria-pressed")).toBe("false");
  });
});

describe("shared app badge", () => {
  it("shows the sharing org's initial on its colour with an accessible label", () => {
    render(<div className="relative"><SharedAppBadge appName="Sales CRM" organization={finna} /></div>);
    const badge = screen.getByRole("img", { name: "Sales CRM — shared from Finna" });
    expect(badge.getAttribute("title")).toBe("Sales CRM — shared from Finna");
    expect(badge.textContent).toBe("F");
    expect(badge.style.background).toBeTruthy();
    expect(organizationColor("org_finna")).toBe(organizationColor("org_finna"));
  });
  it("keeps the generic badge when the org is unknown", () => {
    render(<SharedAppBadge />);
    expect(screen.getByRole("img", { name: "Shared app" })).toBeTruthy();
  });
});

describe("new shared apps", () => {
  const missing = () => Promise.reject(Object.assign(new Error("missing"), { category: "notFound" }));

  it("baselines existing shared apps as seen, marks later ones new until opened", async () => {
    let stored: unknown = null;
    // Mirrors the gateway blob route: replacing an existing file needs force=true.
    const api = { get: vi.fn(missing), put: vi.fn(async (path: string, body: unknown) => {
      if (stored !== null && !path.includes("force=true")) throw Object.assign(new Error("file_exists"), { status: 409 });
      stored = body; return { ok: true };
    }) };
    const { result, rerender } = renderHook(({ ids, ready }) => useSeenSharedApps({ api, scopeIds: ids, ready }), { initialProps: { ids: ["scope-a"], ready: false } });
    expect(result.current.isNew("scope-a")).toBe(false);
    expect(api.get).not.toHaveBeenCalled();
    rerender({ ids: ["scope-a"], ready: true });
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/files/blob?path=system%2Fshare%2Fseen-shared-apps.json&force=true", { version: 1, seen: ["scope-a"] }));
    rerender({ ids: ["scope-a", "scope-b"], ready: true });
    expect(result.current.isNew("scope-a")).toBe(false);
    expect(result.current.isNew("scope-b")).toBe(true);
    act(() => result.current.markSeen("scope-b"));
    expect(result.current.isNew("scope-b")).toBe(false);
    expect(api.put).toHaveBeenLastCalledWith(expect.stringContaining("force=true"), { version: 1, seen: ["scope-a", "scope-b"] });
    await waitFor(() => expect(stored).toEqual({ version: 1, seen: ["scope-a", "scope-b"] }));
  });

  it("keeps an app opened while the saved list loads marked as seen", async () => {
    // Fault: markSeen dropped opens before the read settled, so the app regained its new dot.
    let finish!: (value: unknown) => void;
    const api = { get: vi.fn(() => new Promise((resolve) => { finish = resolve; })), put: vi.fn(async () => ({ ok: true })) };
    const { result } = renderHook(() => useSeenSharedApps({ api, scopeIds: ["scope-a", "scope-b"], ready: true }));
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    act(() => result.current.markSeen("scope-b"));
    await act(async () => finish({ version: 1, seen: ["scope-a"] }));
    expect(result.current.isNew("scope-b")).toBe(false);
    expect(api.put).toHaveBeenLastCalledWith(expect.stringContaining("force=true"), { version: 1, seen: ["scope-a", "scope-b"] });
  });

  it("reads the saved list and never throws when saving fails", async () => {
    const api = { get: vi.fn(async () => ({ version: 1, seen: ["scope-a"] })), put: vi.fn(() => { throw new Error("offline"); }) };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { result } = renderHook(() => useSeenSharedApps({ api, scopeIds: ["scope-a", "scope-b"], ready: true }));
    await waitFor(() => expect(result.current.isNew("scope-b")).toBe(true));
    expect(() => act(() => result.current.markSeen("scope-b"))).not.toThrow();
    expect(result.current.isNew("scope-b")).toBe(false);
  });
});

describe("Web Launchpad", () => {
  it("filters by org chip, labels the org badge, and shows the new dot", async () => {
    const { Launchpad } = await import("../../shell/src/components/launchpad/Launchpad");
    const target = (scopeId: string, appId: string, organizationId: string) => ({
      scopeId, runtimeId: "runtime_owner", organizationId, authorityGeneration: 1, appId,
      catalogId: "30000000-0000-4000-8000-000000000001", readinessId: "40000000-0000-4000-8000-000000000001",
      registrationIncarnation: "a".repeat(64), buildId: "b".repeat(64), shareRevision: "1",
      owner: { actorId: "user_owner", displayName: "Owner" },
    });
    const apps = [
      { name: "Chess", path: "apps/chess/index.html" },
      { name: "Sales CRM", path: "__shared-app__:10000000-0000-4000-8000-000000000001", sharedAppTarget: target("10000000-0000-4000-8000-000000000001", "sales-crm", "org_finna") },
      { name: "Deal room", path: "__shared-app__:10000000-0000-4000-8000-000000000002", sharedAppTarget: target("10000000-0000-4000-8000-000000000002", "deal-room", "org_acme") },
    ];
    render(<Launchpad apps={apps} visible onOpenApp={vi.fn()} onClose={vi.fn()} organizations={[finna, acme]}
      isNewShared={(scopeId) => scopeId === "10000000-0000-4000-8000-000000000001"} />);
    expect(screen.getByRole("button", { name: "Sales CRM — shared from Finna, new" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Deal room — shared from Acme Ventures" })).toBeTruthy();
    expect(screen.getByText("Open an installed app, or choose Create app to start in Chat.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Finna/ }));
    expect(screen.getByText("1 app shared in Finna.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Deal room/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Chess" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mine" }));
    expect(screen.getByRole("button", { name: "Chess" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Sales CRM/ })).toBeNull();
  });
});
