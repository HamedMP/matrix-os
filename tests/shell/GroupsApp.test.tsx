// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { GroupsApp } from "../../shell/src/components/groups/GroupsApp.js";

// ---------------------------------------------------------------------------
// Mock shadcn UI + subcomponents
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
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => {
    const { variant: _v, size: _s, ...rest } = props;
    return <button {...rest} />;
  },
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    <div className={className}>{children}</div>,
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: ({ className }: { className?: string }) => <div className={className} data-testid="skeleton" />,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement> & { variant?: string }) => {
    const { ...rest } = props;
    return <span {...rest}>{children}</span>;
  },
}));

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockGroups = [
  { slug: "family", name: "Family", room_id: "!fam:m.com", owner_handle: "@me:matrix-os.com" },
  { slug: "work", name: "Work", room_id: "!work:m.com", owner_handle: "@me:matrix-os.com" },
];

const mockMembers = [
  { user_id: "@me:matrix-os.com", role: "owner", membership: "join" },
  { user_id: "@bob:matrix-os.com", role: "editor", membership: "join" },
];

const mockApps = [
  { slug: "notes", name: "Notes", entry: "index.html" },
];

const mockPersonalApps = [
  { slug: "notes", name: "Notes" },
  { slug: "todo", name: "Todo" },
];

function setupFetch() {
  global.fetch = vi.fn().mockImplementation((url: string) => {
    if (url.includes("/api/groups") && url.includes("/members")) {
      return Promise.resolve({ ok: true, json: async () => ({ members: mockMembers }) });
    }
    if (url.includes("/api/groups") && url.includes("/apps")) {
      return Promise.resolve({ ok: true, json: async () => ({ apps: mockApps }) });
    }
    if (url.includes("/api/groups")) {
      return Promise.resolve({ ok: true, json: async () => ({ groups: mockGroups }) });
    }
    if (url.includes("/api/apps")) {
      return Promise.resolve({ ok: true, json: async () => ({ apps: mockPersonalApps }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GroupsApp", () => {
  beforeEach(() => {
    setupFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing when closed", () => {
    const { container } = render(<GroupsApp open={false} onOpenChange={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders the app when open", async () => {
    render(<GroupsApp open={true} onOpenChange={() => {}} />);
    expect(screen.getByTestId("groups-app")).toBeDefined();
  });

  it("fetches groups on open", async () => {
    render(<GroupsApp open={true} onOpenChange={() => {}} />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/groups"),
        expect.any(Object),
      );
    });
  });

  it("shows group list after loading", async () => {
    render(<GroupsApp open={true} onOpenChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("groups-list-item-family")).toBeDefined();
      expect(screen.getByTestId("groups-list-item-work")).toBeDefined();
    });
  });

  it("shows empty state when no groups", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ groups: [] }),
    });
    render(<GroupsApp open={true} onOpenChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText("Create your first group to collaborate with others")).toBeDefined();
    });
  });

  it("shows 'Select a group' when groups exist but none selected", async () => {
    render(<GroupsApp open={true} onOpenChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText("Select a group")).toBeDefined();
    });
  });

  it("selects a group and shows detail view", async () => {
    render(<GroupsApp open={true} onOpenChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("groups-list-item-family")).toBeDefined();
    });
    fireEvent.click(screen.getByTestId("groups-list-item-family"));
    await waitFor(() => {
      expect(screen.getByTestId("group-detail-name")).toBeDefined();
      expect(screen.getByTestId("group-detail-name").textContent).toBe("Family");
    });
  });

  it("opens create dialog when clicking create button", async () => {
    render(<GroupsApp open={true} onOpenChange={() => {}} />);
    fireEvent.click(screen.getByTestId("groups-create-btn"));
    expect(screen.getByTestId("dialog")).toBeDefined();
  });

  it("shows member list in group detail", async () => {
    render(<GroupsApp open={true} onOpenChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("groups-list-item-family")).toBeDefined();
    });
    fireEvent.click(screen.getByTestId("groups-list-item-family"));
    await waitFor(() => {
      expect(screen.getByTestId("member-row-@me:matrix-os.com")).toBeDefined();
      expect(screen.getByTestId("member-row-@bob:matrix-os.com")).toBeDefined();
    });
  });

  it("shows shared apps in group detail", async () => {
    render(<GroupsApp open={true} onOpenChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("groups-list-item-family")).toBeDefined();
    });
    fireEvent.click(screen.getByTestId("groups-list-item-family"));
    await waitFor(() => {
      expect(screen.getByTestId("app-row-notes")).toBeDefined();
    });
  });

  it("shows leave button in group detail", async () => {
    render(<GroupsApp open={true} onOpenChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("groups-list-item-family")).toBeDefined();
    });
    fireEvent.click(screen.getByTestId("groups-list-item-family"));
    await waitFor(() => {
      expect(screen.getByTestId("group-leave-btn")).toBeDefined();
    });
  });

  it("shows share app picker when clicking share button", async () => {
    render(<GroupsApp open={true} onOpenChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("groups-list-item-family")).toBeDefined();
    });
    fireEvent.click(screen.getByTestId("groups-list-item-family"));
    await waitFor(() => {
      expect(screen.getByTestId("group-share-app-btn")).toBeDefined();
    });
    fireEvent.click(screen.getByTestId("group-share-app-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("share-app-picker")).toBeDefined();
    });
  });

  it("share picker shows only apps not already shared", async () => {
    render(<GroupsApp open={true} onOpenChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("groups-list-item-family")).toBeDefined();
    });
    fireEvent.click(screen.getByTestId("groups-list-item-family"));
    await waitFor(() => {
      expect(screen.getByTestId("group-share-app-btn")).toBeDefined();
    });
    fireEvent.click(screen.getByTestId("group-share-app-btn"));
    await waitFor(() => {
      // "notes" is already shared, so only "todo" should appear
      expect(screen.getByTestId("share-pick-todo")).toBeDefined();
      expect(screen.queryByTestId("share-pick-notes")).toBeNull();
    });
  });
});
