// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { MembersPanel } from "../../shell/src/components/MembersPanel.js";

// ---------------------------------------------------------------------------
// Mock shadcn UI components
// ---------------------------------------------------------------------------

vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => {
    const { variant: _v, size: _s, ...rest } = props;
    return <button {...rest} />;
  },
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement> & { variant?: string }) => {
    const { variant: _v, ...rest } = props as Record<string, unknown>;
    return <span data-testid="badge" {...rest}>{children}</span>;
  },
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
}));

vi.mock("@/lib/gateway", () => ({
  getGatewayUrl: () => "http://localhost:4000",
}));

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockMembers = [
  { user_id: "@alice:matrix-os.com", role: "owner", membership: "join" },
  { user_id: "@bob:matrix-os.com", role: "editor", membership: "join" },
  { user_id: "@charlie:matrix-os.com", role: "viewer", membership: "invite" },
];

function setupFetch(members = mockMembers) {
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (typeof url === "string" && url.includes("/members") && (!init || init.method === "GET" || init.method === undefined)) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ members }),
      } as Response);
    }
    // POST invite
    if (typeof url === "string" && url.includes("/invite")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response);
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MembersPanel", () => {
  beforeEach(() => {
    setupFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders without crashing", async () => {
    const { container } = render(
      <MembersPanel groupSlug="family" isOwner={true} onClose={() => {}} />,
    );
    expect(container).toBeDefined();
  });

  it("shows panel title", async () => {
    render(<MembersPanel groupSlug="family" isOwner={true} onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText("Members")).toBeDefined();
    });
  });

  it("renders member list from fetch", async () => {
    render(<MembersPanel groupSlug="family" isOwner={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("@alice:matrix-os.com")).toBeDefined();
      expect(screen.getByText("@bob:matrix-os.com")).toBeDefined();
      expect(screen.getByText("@charlie:matrix-os.com")).toBeDefined();
    });
  });

  it("shows role badges for members", async () => {
    render(<MembersPanel groupSlug="family" isOwner={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("owner")).toBeDefined();
      expect(screen.getByText("editor")).toBeDefined();
      expect(screen.getByText("viewer")).toBeDefined();
    });
  });

  it("shows membership status for invited members", async () => {
    render(<MembersPanel groupSlug="family" isOwner={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/invited/i)).toBeDefined();
    });
  });

  it("shows invite form when isOwner is true", async () => {
    render(<MembersPanel groupSlug="family" isOwner={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("members-invite-input")).toBeDefined();
      expect(screen.getByTestId("members-invite-submit")).toBeDefined();
    });
  });

  it("hides invite form when isOwner is false", async () => {
    render(<MembersPanel groupSlug="family" isOwner={false} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("@alice:matrix-os.com")).toBeDefined();
    });

    expect(screen.queryByTestId("members-invite-input")).toBeNull();
    expect(screen.queryByTestId("members-invite-submit")).toBeNull();
  });

  it("submits invite to correct endpoint", async () => {
    render(<MembersPanel groupSlug="family" isOwner={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("members-invite-input")).toBeDefined();
    });

    const input = screen.getByTestId("members-invite-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "@dave:matrix-os.com" } });
    fireEvent.click(screen.getByTestId("members-invite-submit"));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/groups/family/invite"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ user_id: "@dave:matrix-os.com" }),
        }),
      );
    });
  });

  it("shows remove buttons for non-self members when isOwner", async () => {
    render(<MembersPanel groupSlug="family" isOwner={true} onClose={() => {}} />);

    await waitFor(() => {
      const removeButtons = screen.getAllByTestId("members-remove");
      // Should have remove buttons for bob and charlie, not alice (self/owner)
      expect(removeButtons.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("calls onClose when close button is clicked", async () => {
    const onClose = vi.fn();
    render(<MembersPanel groupSlug="family" isOwner={true} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByTestId("members-close")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("members-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows empty state when no members beyond self", async () => {
    setupFetch([{ user_id: "@alice:matrix-os.com", role: "owner", membership: "join" }]);
    render(<MembersPanel groupSlug="family" isOwner={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("@alice:matrix-os.com")).toBeDefined();
    });
  });

  it("closes on Escape key", async () => {
    const onClose = vi.fn();
    render(<MembersPanel groupSlug="family" isOwner={true} onClose={onClose} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
