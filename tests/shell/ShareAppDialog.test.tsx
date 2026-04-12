// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { ShareAppDialog } from "../../shell/src/components/ShareAppDialog.js";

// ---------------------------------------------------------------------------
// Mock shadcn UI
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

vi.mock("@/lib/gateway", () => ({
  getGatewayUrl: () => "http://localhost:4000",
}));

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockGroups = [
  { slug: "family", name: "Schmidt Family", room_id: "!fam:m.com" },
  { slug: "work", name: "Work Team", room_id: "!work:m.com" },
];

function setupFetch(groups = mockGroups) {
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    // GET /api/groups
    if (typeof url === "string" && url.endsWith("/api/groups") && (!init || !init.method || init.method === "GET")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ groups }),
      } as Response);
    }
    // POST share-app
    if (typeof url === "string" && url.includes("/share-app")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ slug: "family", app_slug: "notes" }),
      } as Response);
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
  });
}

function setupFetchShareFail() {
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (typeof url === "string" && url.endsWith("/api/groups") && (!init || !init.method || init.method === "GET")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ groups: mockGroups }),
      } as Response);
    }
    if (typeof url === "string" && url.includes("/share-app")) {
      return Promise.resolve({
        ok: false,
        status: 403,
        json: async () => ({ error: "Forbidden" }),
      } as Response);
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ShareAppDialog", () => {
  beforeEach(() => {
    setupFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders without crashing when open", async () => {
    const { container } = render(
      <ShareAppDialog appSlug="notes" open={true} onOpenChange={() => {}} />,
    );
    expect(container).toBeDefined();
  });

  it("does not render when closed", () => {
    render(
      <ShareAppDialog appSlug="notes" open={false} onOpenChange={() => {}} />,
    );
    expect(screen.queryByTestId("dialog")).toBeNull();
  });

  it("shows dialog title", async () => {
    render(
      <ShareAppDialog appSlug="notes" open={true} onOpenChange={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText("Share app")).toBeDefined();
    });
  });

  it("renders group list from fetch", async () => {
    render(
      <ShareAppDialog appSlug="notes" open={true} onOpenChange={() => {}} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Schmidt Family")).toBeDefined();
      expect(screen.getByText("Work Team")).toBeDefined();
    });
  });

  it("triggers POST share-app on group selection", async () => {
    const onOpenChange = vi.fn();
    render(
      <ShareAppDialog appSlug="notes" open={true} onOpenChange={onOpenChange} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("share-group-family")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("share-group-family"));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/groups/family/share-app"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ app_slug: "notes" }),
        }),
      );
    });
  });

  it("closes dialog on success", async () => {
    const onOpenChange = vi.fn();
    render(
      <ShareAppDialog appSlug="notes" open={true} onOpenChange={onOpenChange} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("share-group-family")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("share-group-family"));

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("shows error message on failure", async () => {
    setupFetchShareFail();
    render(
      <ShareAppDialog appSlug="notes" open={true} onOpenChange={() => {}} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("share-group-family")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("share-group-family"));

    await waitFor(() => {
      expect(screen.getByTestId("share-error")).toBeDefined();
    });
  });

  it("shows empty state when no groups exist", async () => {
    setupFetch([]);
    render(
      <ShareAppDialog appSlug="notes" open={true} onOpenChange={() => {}} />,
    );

    await waitFor(() => {
      expect(screen.getByText(/no groups/i)).toBeDefined();
    });
  });
});
