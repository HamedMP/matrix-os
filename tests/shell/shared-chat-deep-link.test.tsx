import React, { type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import SharedChatPage from "../../shell/src/app/shared/chat/[scopeId]/page";

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
