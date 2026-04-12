// @vitest-environment jsdom

/**
 * Tests for GroupSwitcher component (T052a).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { GroupSwitcher } from "../../shell/src/components/GroupSwitcher.js";

// ---------------------------------------------------------------------------
// Mock global fetch for GET /api/groups
// ---------------------------------------------------------------------------

const mockGroups = [
  { slug: "fam", name: "Schmidt Family", member_count: 3 },
  { slug: "work", name: "Work Team", member_count: 5 },
];

function setupFetch(groups = mockGroups) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => groups,
  } as Response);
}

// ---------------------------------------------------------------------------
// URL tracking helper
// ---------------------------------------------------------------------------

let currentSearch = "";

function mockUrlParam(initial = "") {
  currentSearch = initial;
  // Override URLSearchParams to track group param
  const originalLocation = window.location;
  Object.defineProperty(window, "location", {
    writable: true,
    value: {
      ...originalLocation,
      search: initial,
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GroupSwitcher", () => {
  let onGroupChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onGroupChange = vi.fn();
    setupFetch();
  });

  it("renders without crashing", async () => {
    const { container } = render(
      <GroupSwitcher onGroupChange={onGroupChange} />,
    );
    expect(container).toBeDefined();
  });

  it("shows a Personal entry first in the listbox", async () => {
    render(<GroupSwitcher onGroupChange={onGroupChange} />);

    const trigger = screen.getByRole("button");
    fireEvent.click(trigger);

    await waitFor(() => {
      const listbox = screen.getByRole("listbox");
      expect(listbox.textContent).toContain("Personal");
    });
  });

  it("lists groups fetched from GET /api/groups", async () => {
    render(<GroupSwitcher onGroupChange={onGroupChange} />);

    const trigger = screen.getByRole("button");
    fireEvent.click(trigger);

    await waitFor(() => {
      const listbox = screen.getByRole("listbox");
      expect(listbox.textContent).toContain("Schmidt Family");
      expect(listbox.textContent).toContain("Work Team");
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/groups",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("calls onGroupChange with slug when a group is selected", async () => {
    render(<GroupSwitcher onGroupChange={onGroupChange} />);

    const trigger = screen.getByRole("button");
    fireEvent.click(trigger);

    await waitFor(() => screen.getByRole("listbox"));
    await waitFor(() => screen.getByText("Schmidt Family"));
    fireEvent.click(screen.getByText("Schmidt Family"));

    expect(onGroupChange).toHaveBeenCalledWith("fam");
  });

  it("calls onGroupChange with null when Personal is selected", async () => {
    render(<GroupSwitcher onGroupChange={onGroupChange} />);

    const trigger = screen.getByRole("button");
    fireEvent.click(trigger);

    // Click the Personal option in the listbox (not the trigger)
    await waitFor(() => screen.getByRole("listbox"));
    const listbox = screen.getByRole("listbox");
    const personalOption = listbox.querySelector('[role="option"]') as HTMLElement;
    fireEvent.click(personalOption);

    expect(onGroupChange).toHaveBeenCalledWith(null);
  });

  it("shows current group name in trigger when activeGroupSlug provided", async () => {
    render(
      <GroupSwitcher onGroupChange={onGroupChange} activeGroupSlug="fam" />,
    );

    await waitFor(() => {
      const trigger = screen.getByRole("button");
      expect(trigger.textContent).toMatch(/Schmidt Family|fam/);
    });
  });

  it("shows 'Personal' in trigger when no activeGroupSlug", async () => {
    render(<GroupSwitcher onGroupChange={onGroupChange} />);

    const trigger = screen.getByRole("button");
    expect(trigger.textContent).toMatch(/Personal/i);
  });
});
