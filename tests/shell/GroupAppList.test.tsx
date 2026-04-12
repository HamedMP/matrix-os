// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { GroupAppList } from "../../shell/src/components/GroupAppList.js";

// ---------------------------------------------------------------------------
// Mock shadcn UI + gateway
// ---------------------------------------------------------------------------

vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => {
    const { variant: _v, size: _s, ...rest } = props;
    return <button {...rest} />;
  },
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/gateway", () => ({
  getGatewayUrl: () => "http://localhost:4000",
}));

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockApps = [
  { slug: "notes", name: "My Notes" },
  { slug: "todo", name: "Todo List" },
];

function setupFetch(apps = mockApps) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ apps }),
  } as unknown as Response);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GroupAppList", () => {
  beforeEach(() => {
    setupFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders without crashing", async () => {
    const { container } = render(
      <GroupAppList groupSlug="family" onOpenApp={() => {}} />,
    );
    expect(container).toBeDefined();
  });

  it("fetches apps for the group", async () => {
    render(<GroupAppList groupSlug="family" onOpenApp={() => {}} />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/groups/family/apps"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  it("renders app tiles", async () => {
    render(<GroupAppList groupSlug="family" onOpenApp={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("My Notes")).toBeDefined();
      expect(screen.getByText("Todo List")).toBeDefined();
    });
  });

  it("calls onOpenApp with slug on click", async () => {
    const onOpenApp = vi.fn();
    render(<GroupAppList groupSlug="family" onOpenApp={onOpenApp} />);

    await waitFor(() => {
      expect(screen.getByTestId("group-app-notes")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("group-app-notes"));
    expect(onOpenApp).toHaveBeenCalledWith("notes", "My Notes");
  });

  it("shows empty state when no apps", async () => {
    setupFetch([]);
    render(<GroupAppList groupSlug="family" onOpenApp={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/no shared apps/i)).toBeDefined();
    });
  });

  it("re-fetches when groupSlug changes", async () => {
    const { rerender } = render(
      <GroupAppList groupSlug="family" onOpenApp={() => {}} />,
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    rerender(<GroupAppList groupSlug="work" onOpenApp={() => {}} />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/groups/work/apps"),
        expect.any(Object),
      );
    });
  });
});
