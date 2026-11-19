// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import RootLayout from "../../shell/src/app/layout";
import { FileBrowser } from "../../shell/src/components/file-browser/FileBrowser";
import { ShellChatCollaboration } from "../../shell/src/components/chat/ShellChatCollaboration";

vi.mock("@clerk/nextjs", async () => {
  const { createContext, createElement, useContext } = await import("react");
  const available = createContext(false);
  const assertProvider = () => {
    if (!useContext(available)) throw new Error("Missing ClerkProvider");
  };
  return {
    ClerkProvider: ({ children }: { children: React.ReactNode }) => createElement(available.Provider, { value: true }, children),
    useAuth: () => { assertProvider(); return { isLoaded: true, userId: "user_e2e", sessionId: null }; },
    useUser: () => { assertProvider(); return { isLoaded: false, user: null }; },
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/", useSearchParams: () => new URLSearchParams(),
}));
afterEach(() => vi.unstubAllEnvs());

it.each([
  ["Files", () => createElement(FileBrowser, { windowId: "fixture-files" })],
  ["Shared Chat", () => createElement(ShellChatCollaboration, { view: { kind: "chat", scopeId: "fixture-chat" } })],
] as const)("keeps Clerk context for %s in managed E2E bypass mode", (_name, content) => {
  vi.stubEnv("MATRIX_SELF_HOSTED", undefined);
  vi.stubEnv("NEXT_PUBLIC_E2E_TEST_BYPASS", "1");
  expect(() => renderToStaticMarkup(createElement(RootLayout, { children: content() }))).not.toThrow();
});

it("mounts ClerkProvider inside <body>, as Clerk Core 3 requires", async () => {
  vi.stubEnv("MATRIX_SELF_HOSTED", undefined);
  vi.stubEnv("NEXT_PUBLIC_E2E_TEST_BYPASS", "1");
  const { ClerkProvider } = await import("@clerk/nextjs");
  const tree = RootLayout({ children: createElement("main") });
  expect(tree.type).toBe("html");
  const body = (tree.props as { children: React.ReactElement<{ children: React.ReactNode }> }).children;
  expect(body.type).toBe("body");
  const bodyChildren = [body.props.children].flat() as React.ReactElement[];
  expect(bodyChildren.some((child) => child?.type === ClerkProvider)).toBe(true);
});
