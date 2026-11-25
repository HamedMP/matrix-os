// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MobileShell } from "../../shell/src/components/mobile/MobileShell";
import { setPhoneViewport } from "./mobile-shell-test-utils";

// User outcome: on Web Mobile, where app screens have no title-bar Share, an owner
// can still reach organization sharing from the app. Fault: MobileShell opening
// owner apps without the inline share control.
const viewer = vi.hoisted(() => ({ props: null as null | { path: string; inlineShareControls?: boolean } }));
vi.mock("@/hooks/useFileWatcher", () => ({ useFileWatcher: () => undefined }));
vi.mock("@/stores/chat-context", () => ({ useChatContext: () => null }));
vi.mock("@/components/Settings", () => ({ Settings: () => null }));
vi.mock("@/components/ChatApp", () => ({ ChatApp: () => null }));
vi.mock("@/components/terminal/TerminalApp", () => ({ TerminalApp: () => null }));
vi.mock("@/components/file-browser/FileBrowser", () => ({ FileBrowser: () => null }));
vi.mock("@/components/preview-window/PreviewWindow", () => ({ PreviewWindow: () => null }));
vi.mock("@/hooks/useTheme", () => ({ useTheme: () => ({ mode: "light", colors: {}, fonts: {} }) }));
vi.mock("@/components/AppViewer", () => ({
  AppViewer: (props: { path: string; inlineShareControls?: boolean }) => {
    viewer.props = props;
    return <div data-testid={`viewer:${props.path}`} />;
  },
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); viewer.props = null; });

it("opens an owner app on Web Mobile with the inline share control", async () => {
  setPhoneViewport();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [{ name: "Team Tracker", path: "apps/team-tracker/index.html" }] })));
  render(<MobileShell />);
  fireEvent.click(await screen.findByRole("button", { name: "Team Tracker" }));

  await waitFor(() => expect(viewer.props?.path).toBe("apps/team-tracker/index.html"));
  expect(viewer.props?.inlineShareControls).toBe(true);
});
