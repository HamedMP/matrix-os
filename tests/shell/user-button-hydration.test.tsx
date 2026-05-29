import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true }),
  UserButton: () => <div data-testid="clerk-user-button" data-clerk-component="UserButton" />,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("UserButton hydration shell", () => {
  it("server-renders the stable placeholder even when Clerk will hydrate signed in", async () => {
    const { UserButton } = await import("../../shell/src/components/UserButton.js");
    const html = renderToString(<UserButton />);

    expect(html).toContain("lucide-user");
    expect(html).not.toContain("data-clerk-component");
  });
});
