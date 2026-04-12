// @vitest-environment jsdom

/**
 * Tests for AppAclPanel React component (T058a).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { AppAclPanel } from "../../shell/src/components/AppAclPanel.js";
import type { GroupAcl } from "../../shell/src/components/AppAclPanel.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultAcl: GroupAcl = {
  read_pl: 0,
  write_pl: 50,
  install_pl: 100,
  policy: "open",
};

function setup(overrides?: Partial<{
  acl: GroupAcl;
  groupSlug: string;
  appSlug: string;
  myPowerLevel: number;
  onSaved: (acl: GroupAcl) => void;
}>) {
  const props = {
    acl: overrides?.acl ?? defaultAcl,
    groupSlug: overrides?.groupSlug ?? "fam",
    appSlug: overrides?.appSlug ?? "notes",
    myPowerLevel: overrides?.myPowerLevel ?? 100,
    onSaved: overrides?.onSaved ?? vi.fn(),
  };
  return { props, ...render(<AppAclPanel {...props} />) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AppAclPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── Disabled state ────────────────────────────────────────────────────────

  it("disables save button when myPowerLevel < install_pl", () => {
    setup({ myPowerLevel: 50, acl: { ...defaultAcl, install_pl: 100 } });

    const saveBtn = screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it("disables form fields when myPowerLevel < install_pl", () => {
    setup({ myPowerLevel: 0 });

    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    for (const s of selects) {
      expect(s.disabled).toBe(true);
    }
  });

  it("renders title explaining why disabled when myPowerLevel < install_pl", () => {
    setup({ myPowerLevel: 0 });

    const saveBtn = screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    const wrapper = saveBtn.closest("[title]");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.getAttribute("title")).toMatch(/insufficient|install_pl/i);
  });

  it("enables form and save button when myPowerLevel >= install_pl", () => {
    setup({ myPowerLevel: 100, acl: { ...defaultAcl, install_pl: 100 } });

    const saveBtn = screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
  });

  // ── Rendering ─────────────────────────────────────────────────────────────

  it("renders current ACL values from props", () => {
    setup({ acl: { read_pl: 0, write_pl: 50, install_pl: 100, policy: "moderated" } });

    // Policy select should show "moderated"
    expect(document.body.textContent).toContain("moderated");
  });

  // ── Optimistic update ─────────────────────────────────────────────────────

  it("calls POST /api/groups/:slug/apps/:app/acl with updated ACL on save", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const { props } = setup({ myPowerLevel: 100 });

    // Change policy to "owner_only"
    const policySelect = screen.getByRole("combobox", { name: /policy/i });
    fireEvent.change(policySelect, { target: { value: "owner_only" } });

    const saveBtn = screen.getByRole("button", { name: /save/i });
    await act(async () => { fireEvent.click(saveBtn); });

    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/groups/${props.groupSlug}/apps/${props.appSlug}/acl`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        body: expect.stringContaining("owner_only"),
      })
    );
  });

  it("calls onSaved with new ACL after successful save", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const onSaved = vi.fn();
    setup({ myPowerLevel: 100, onSaved });

    const saveBtn = screen.getByRole("button", { name: /save/i });
    await act(async () => { fireEvent.click(saveBtn); });

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ policy: "open" }));
  });

  // ── Rollback on error ─────────────────────────────────────────────────────

  it("reverts to previous ACL and shows error when save fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })
    );

    setup({ myPowerLevel: 100, acl: { ...defaultAcl, policy: "open" } });

    const policySelect = screen.getByRole("combobox", { name: /policy/i });
    fireEvent.change(policySelect, { target: { value: "owner_only" } });

    const saveBtn = screen.getByRole("button", { name: /save/i });
    await act(async () => { fireEvent.click(saveBtn); });

    // Should show error message
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/error|fail|forbidden/i);
    });

    // Policy select should revert to "open"
    expect((policySelect as HTMLSelectElement).value).toBe("open");
  });

  it("reverts ACL and shows error when fetch rejects (network error)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network error"));

    setup({ myPowerLevel: 100, acl: { ...defaultAcl, policy: "open" } });

    const policySelect = screen.getByRole("combobox", { name: /policy/i });
    fireEvent.change(policySelect, { target: { value: "moderated" } });

    const saveBtn = screen.getByRole("button", { name: /save/i });
    await act(async () => { fireEvent.click(saveBtn); });

    await waitFor(() => {
      expect(document.body.textContent).toMatch(/error|fail/i);
    });

    expect((policySelect as HTMLSelectElement).value).toBe("open");
  });
});
