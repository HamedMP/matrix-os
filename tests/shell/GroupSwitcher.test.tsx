// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { GroupSwitcher } from "../../shell/src/components/GroupSwitcher.js";

// ---------------------------------------------------------------------------
// Mock shadcn UI components (Dialog/Button/Input) — jsdom has no radix
// ---------------------------------------------------------------------------

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => {
    const { variant: _variant, ...rest } = props;
    return <button {...rest} />;
  },
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockGroups = [
  { slug: "fam", name: "Schmidt Family", room_id: "!fam:m.com" },
  { slug: "work", name: "Work Team", room_id: "!work:m.com" },
];

function setupFetch(groups = mockGroups) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ groups }),
  } as unknown as Response);
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders without crashing", async () => {
    const { container } = render(<GroupSwitcher onGroupChange={onGroupChange} />);
    expect(container).toBeDefined();
  });

  it("shows Personal label in trigger by default", () => {
    render(<GroupSwitcher onGroupChange={onGroupChange} />);
    const trigger = screen.getByTestId("group-switcher-trigger");
    expect(trigger.textContent).toContain("Personal");
  });

  it("opens dropdown and shows Personal item on click", async () => {
    render(<GroupSwitcher onGroupChange={onGroupChange} />);
    fireEvent.click(screen.getByTestId("group-switcher-trigger"));
    expect(screen.getByTestId("group-switcher-item-personal")).toBeDefined();
    expect(screen.getByTestId("group-switcher-item-personal").textContent).toContain("Personal");
  });

  it("lists groups fetched from GET /api/groups", async () => {
    render(<GroupSwitcher onGroupChange={onGroupChange} />);
    fireEvent.click(screen.getByTestId("group-switcher-trigger"));

    await waitFor(() => {
      expect(screen.getByTestId("group-switcher-item-fam")).toBeDefined();
      expect(screen.getByTestId("group-switcher-item-work")).toBeDefined();
    });

    expect(screen.getByTestId("group-switcher-item-fam").textContent).toContain("Schmidt Family");
    expect(screen.getByTestId("group-switcher-item-work").textContent).toContain("Work Team");
  });

  it("calls onGroupChange with slug when a group is selected", async () => {
    render(<GroupSwitcher onGroupChange={onGroupChange} />);
    fireEvent.click(screen.getByTestId("group-switcher-trigger"));

    await waitFor(() => screen.getByTestId("group-switcher-item-fam"));
    fireEvent.click(screen.getByTestId("group-switcher-item-fam"));

    expect(onGroupChange).toHaveBeenCalledWith("fam");
  });

  it("calls onGroupChange with null when Personal is selected", async () => {
    render(<GroupSwitcher onGroupChange={onGroupChange} />);
    fireEvent.click(screen.getByTestId("group-switcher-trigger"));
    fireEvent.click(screen.getByTestId("group-switcher-item-personal"));

    expect(onGroupChange).toHaveBeenCalledWith(null);
  });

  it("closes dropdown after selection", async () => {
    render(<GroupSwitcher onGroupChange={onGroupChange} />);
    fireEvent.click(screen.getByTestId("group-switcher-trigger"));

    await waitFor(() => screen.getByTestId("group-switcher-item-fam"));
    fireEvent.click(screen.getByTestId("group-switcher-item-fam"));

    expect(screen.queryByTestId("group-switcher-item-personal")).toBeNull();
  });

  it("shows New group button in dropdown", () => {
    render(<GroupSwitcher onGroupChange={onGroupChange} />);
    fireEvent.click(screen.getByTestId("group-switcher-trigger"));
    expect(screen.getByTestId("group-switcher-new").textContent).toContain("New group");
  });

  it("opens create dialog when New group is clicked", () => {
    render(<GroupSwitcher onGroupChange={onGroupChange} />);
    fireEvent.click(screen.getByTestId("group-switcher-trigger"));
    fireEvent.click(screen.getByTestId("group-switcher-new"));

    expect(screen.getByTestId("dialog")).toBeDefined();
    expect(screen.getByTestId("group-create-name")).toBeDefined();
  });
});
