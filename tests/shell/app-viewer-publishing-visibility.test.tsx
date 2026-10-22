// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppViewer } from "@/components/AppViewer";

vi.mock("@/hooks/useFileWatcher", () => ({ useFileWatcher: () => undefined }));
vi.mock("@/hooks/useSocket", () => ({
  useSocket: () => ({ send: vi.fn(), subscribe: () => () => undefined }),
}));
vi.mock("@/lib/app-session", () => ({ openAppSession: vi.fn(() => new Promise<void>(() => undefined)) }));
vi.mock("@/lib/posthog-client", () => ({ capturePostHogEvent: vi.fn() }));
vi.mock("@/components/app-sites/AppSiteButton", () => ({
  AppSiteButton: ({ appSlug }: { appSlug: string }) => <div data-testid="publish-app">{appSlug}</div>,
}));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><body>App</body></html>")));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("unmounts portal-backed publishing controls while the owning app is hidden", () => {
  const view = render(<AppViewer path="apps/demo/index.html" visible />);
  expect(screen.getByTestId("publish-app").textContent).toBe("demo");

  view.rerender(<AppViewer path="apps/demo/index.html" visible={false} />);
  expect(screen.queryByTestId("publish-app")).toBeNull();

  view.rerender(<AppViewer path="apps/demo/index.html" visible />);
  expect(screen.getByTestId("publish-app").textContent).toBe("demo");
});
