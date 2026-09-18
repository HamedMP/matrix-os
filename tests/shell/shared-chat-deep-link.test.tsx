import React, { type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import SharedChatPage from "../../shell/src/app/shared/chat/[scopeId]/page";
import SharedTerminalPage from "../../shell/src/app/shared/terminal/[scopeId]/page";
import SharedInvitationPage from "../../shell/src/app/shared/invitations/[invitationId]/page";

vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

const scopeId = "10000000-0000-4000-8000-000000000001";

function componentNames(node: ReactNode): string[] {
  if (!React.isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  const type = element.type;
  const name = typeof type === "string" ? type : type.displayName ?? type.name;
  return [name, ...React.Children.toArray(element.props.children).flatMap(componentNames)];
}

describe("shared Chat deep link", () => {
  it("bootstraps the complete shell with Chat focused instead of rendering CollaborationPage", async () => {
    const page = await SharedChatPage({ params: Promise.resolve({ scopeId }) });
    const names = componentNames(page);

    expect(names).toContain("ShellHome");
    expect(names).not.toContain("CollaborationPage");
    expect(JSON.stringify(page)).toContain(scopeId);
  });

  it("rejects malformed scope IDs at the server route boundary", async () => {
    await expect(SharedChatPage({
      params: Promise.resolve({ scopeId: "../../not-a-scope" }),
    })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("shared Terminal deep link", () => {
  it("bootstraps the complete shell with the native Terminal focused", async () => {
    const page = await SharedTerminalPage({ params: Promise.resolve({ scopeId }) });
    const names = componentNames(page);

    expect(names).toContain("ShellHome");
    expect(names).not.toContain("CollaborationPage");
    expect(JSON.stringify(page)).toContain(scopeId);
  });

  it("rejects malformed scope IDs at the server route boundary", async () => {
    await expect(SharedTerminalPage({
      params: Promise.resolve({ scopeId: "../../not-a-scope" }),
    })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("collaboration invitation deep link", () => {
  it("resolves into the native Matrix shell", async () => {
    const invitationId = "30000000-0000-4000-8000-000000000001";
    const page = await SharedInvitationPage({ params: Promise.resolve({ invitationId }) });
    const names = componentNames(page);

    expect(names).toContain("ShellHome");
    expect(names).not.toContain("CollaborationPage");
    expect(JSON.stringify(page)).toContain(invitationId);
  });

  it("rejects malformed invitation IDs at the route boundary", async () => {
    await expect(SharedInvitationPage({
      params: Promise.resolve({ invitationId: "../../not-an-invitation" }),
    })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
