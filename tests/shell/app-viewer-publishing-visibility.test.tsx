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
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><body>App</body></html>")));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("does not insert a publishing row into the created app content", () => {
  const view = render(<AppViewer path="apps/demo/index.html" visible />);
  expect(screen.queryByTestId("app-publishing-bar")).toBeNull();
  expect(screen.queryByRole("button", { name: "Publish app" })).toBeNull();

  view.rerender(<AppViewer path="apps/demo/index.html" visible={false} />);
  expect(screen.queryByTestId("app-publishing-bar")).toBeNull();

  view.rerender(<AppViewer path="apps/demo/index.html" visible />);
  expect(screen.queryByTestId("app-publishing-bar")).toBeNull();
});
