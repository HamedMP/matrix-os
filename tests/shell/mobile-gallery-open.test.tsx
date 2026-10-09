// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MobileShell } from "../../shell/src/components/mobile/MobileShell";
import { setPhoneViewport } from "./mobile-shell-test-utils";

vi.mock("@/hooks/useFileWatcher", () => ({ useFileWatcher: () => undefined }));
vi.mock("@/stores/chat-context", () => ({ useChatContext: () => null }));
vi.mock("@/components/Settings", () => ({ Settings: () => null }));
vi.mock("@/components/ChatApp", () => ({ ChatApp: () => null }));
vi.mock("@/components/terminal/TerminalApp", () => ({ TerminalApp: () => null }));
vi.mock("@/components/file-browser/FileBrowser", () => ({ FileBrowser: () => null }));
vi.mock("@/components/preview-window/PreviewWindow", () => ({ PreviewWindow: () => null }));
vi.mock("@/hooks/useTheme", () => ({ useTheme: () => ({ mode: "light", colors: {}, fonts: {} }) }));
vi.mock("@/components/AppViewer", () => ({ AppViewer: ({ path, onOpenApp }: { path: string; onOpenApp: (name: string, path: string) => void }) => (
  <div data-testid={`viewer:${path}`}>
    <button onClick={() => onOpenApp("Focus", "/files/apps/focus")}>Open installed Focus</button>
    <button onClick={() => onOpenApp("App Gallery", "apps/app-gallery")}>Return to Gallery</button>
  </div>
) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("opens newly installed apps from Gallery and focuses existing mobile stack entries", async () => {
  setPhoneViewport();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [{ name: "App Gallery", path: "apps/app-gallery/index.html" }] })));
  render(<MobileShell />);
  fireEvent.click(await screen.findByRole("button", { name: "App Gallery" }));
  const gallery = screen.getByTestId("viewer:apps/app-gallery/index.html");
  fireEvent.click(gallery.querySelector("button")!);
  await waitFor(() => expect(screen.getByTestId("viewer:apps/focus/index.html")).toBeTruthy());
  expect(screen.getByText("Focus", { selector: "header span" })).toBeTruthy();
  const focus = screen.getByTestId("viewer:apps/focus/index.html");
  fireEvent.click(focus.querySelectorAll("button")[1]);
  expect(screen.getAllByTestId("viewer:apps/app-gallery/index.html")).toHaveLength(1);
  fireEvent.click(gallery.querySelector("button")!);
  expect(screen.getAllByTestId("viewer:apps/focus/index.html")).toHaveLength(1);
  expect(screen.getByText("Focus", { selector: "header span" })).toBeTruthy();
});
