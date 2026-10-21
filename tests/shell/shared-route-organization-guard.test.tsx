// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const chatCollaboration = vi.hoisted(() => vi.fn(() => <div>Live collaboration</div>));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, userId: "user_solo" }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../../shell/src/hooks/useBrowserOrigin", () => ({ useBrowserOrigin: () => "https://app.matrix-os.com" }));
vi.mock("../../shell/src/lib/collaboration", () => ({
  createShellCollaborationApi: () => ({ get: vi.fn() }),
  releaseShellCollaborationApi: vi.fn(),
}));
vi.mock("@matrix-os/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@matrix-os/ui")>()),
  ChatCollaboration: chatCollaboration,
}));

import { ShellChatCollaboration } from "../../shell/src/components/chat/ShellChatCollaboration";
import { OrganizationStateProvider } from "../../shell/src/lib/collaboration-organization-state";

describe("shared route organization guard", () => {
  it("explains an old deep link after organization access is gone", () => {
    render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}>
      <ShellChatCollaboration view={{ kind: "home" }} />
    </OrganizationStateProvider>);

    expect(screen.getByRole("alert")).toHaveTextContent("Organization sharing is no longer available");
    expect(chatCollaboration).not.toHaveBeenCalled();
  });
});
