import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Linking } from "react-native";
import AppRuntimeFrame from "@/components/AppRuntimeFrame";

jest.mock("react-native-webview", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Jest's hoisted mock factory.
  const { View } = require("react-native");
  return { __esModule: true, default: (props: object) => <View testID="webview" {...props} /> };
});

// Exercise the pinned library's actual whitelist wrapper: a rejected origin
// otherwise opens Linking directly and skips the app's navigation callback.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Exercise the real native wrapper with partial native events.
const { createOnShouldStartLoadWithRequest } = require("react-native-webview/lib/WebViewShared");

const runtime = "https://app.matrix-os.com/apps/notes/?session=token";
let open: jest.SpyInstance;

function navigate(url: string, isTopFrame?: boolean) {
  const props = screen.getByTestId("webview").props;
  const load = jest.fn();
  act(() => createOnShouldStartLoadWithRequest(
    load, props.originWhitelist, props.onShouldStartLoadWithRequest,
  )({ nativeEvent: { url, isTopFrame, lockIdentifier: 1 } }));
  return load;
}

describe("app runtime frame", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    jest.spyOn(Linking, "canOpenURL").mockResolvedValue(true);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    "https://outside.example/checkout",
    "matrixos://auth",
    "https://app.matrix-os.com/settings",
    "https://app.matrix-os.com/apps/tasks/",
    "//outside.example",
    "not a URL",
  ])("blocks %s without a whitelist auto-opener", async (target) => {
    render(<AppRuntimeFrame url={runtime} title="Notes" />);
    expect(navigate(target)).toHaveBeenCalledWith(false, target, 1);
    await act(async () => { await Promise.resolve(); });
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByText("This link is unavailable in this app preview.")).toBeTruthy();
    expect(screen.queryByText(target)).toBeNull();
  });

  it("preserves session redirect, SPA paths, and hash routes", () => {
    render(<AppRuntimeFrame url={runtime} title="Notes" />);
    for (const target of [runtime, "https://app.matrix-os.com/apps/notes/", "https://app.matrix-os.com/apps/notes/page#saved"]) {
      expect(navigate(target)).toHaveBeenCalledWith(true, target, 1);
    }
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    "about:blank",
    "https://app.matrix-os.com/apps/notes/embedded",
    "https://embedded.example/document",
  ])("leaves an iOS subframe alone without a notice or external opener: %s", (target) => {
    const authorize = jest.fn(() => true);
    render(<AppRuntimeFrame url={runtime} title="Notes" canOpenExternalUrl={authorize} />);
    expect(navigate(target, false)).toHaveBeenCalledWith(true, target, 1);
    expect(open).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(screen.queryByText("This link is unavailable in this app preview.")).toBeNull();
  });

  it("does not let subframe activity dismiss a top-level blocked notice", () => {
    render(<AppRuntimeFrame url={runtime} title="Notes" />);
    navigate("https://outside.example/", true);
    navigate("https://app.matrix-os.com/apps/notes/embedded", false);
    expect(screen.getByText("This link is unavailable in this app preview.")).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
  });

  it("still confines an explicitly identified top-level request", () => {
    render(<AppRuntimeFrame url={runtime} title="Notes" />);
    expect(navigate("https://outside.example/", true)).toHaveBeenCalledWith(false, "https://outside.example/", 1);
    expect(screen.getByText("This link is unavailable in this app preview.")).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
  });

  it("can dismiss the notice and recover on valid app navigation", () => {
    render(<AppRuntimeFrame url={runtime} title="Notes" />);
    navigate("https://outside.example/");
    fireEvent.press(screen.getByRole("button", { name: "Continue in app" }));
    expect(screen.queryByText("This link is unavailable in this app preview.")).toBeNull();
    navigate("https://outside.example/");
    navigate("https://app.matrix-os.com/apps/notes/page");
    expect(screen.queryByText("This link is unavailable in this app preview.")).toBeNull();
  });

  it("does not carry the notice into another app session", () => {
    const view = render(<AppRuntimeFrame url={runtime} title="Notes" />);
    navigate("https://outside.example/");
    view.rerender(<AppRuntimeFrame url="https://app.matrix-os.com/apps/tasks/?session=new" title="Tasks" />);
    expect(screen.queryByText("This link is unavailable in this app preview.")).toBeNull();
  });

  it("opens only an explicitly reviewed safe external web link", () => {
    const allow = jest.fn((url) => url === "https://help.example/guide");
    render(<AppRuntimeFrame url={runtime} title="Notes" canOpenExternalUrl={allow} />);
    navigate("https://help.example/guide");
    expect(open).toHaveBeenCalledWith("https://help.example/guide");
    navigate("https://help.example/denied");
    navigate("matrixos://auth");
    navigate("https://app.matrix-os.com/settings");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("intercepts new-window links without native fallback", () => {
    render(<AppRuntimeFrame url={runtime} title="Notes" />);
    act(() => screen.getByTestId("webview").props.onOpenWindow({ nativeEvent: { targetUrl: "https://outside.example/" } }));
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByText("This link is unavailable in this app preview.")).toBeTruthy();
    expect(screen.getByTestId("webview").props.setSupportMultipleWindows).toBe(true);
  });

  it("does not mount a WebView for an invalid initial runtime URL", () => {
    render(<AppRuntimeFrame url="https://app.matrix-os.com/settings" title="Notes" />);
    expect(screen.queryByTestId("webview")).toBeNull();
    expect(screen.getByText("Notes could not load")).toBeTruthy();
  });

  it("shows recovery when an explicitly authorized browser open fails", async () => {
    open.mockRejectedValueOnce(new Error("private provider detail"));
    const log = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    render(<AppRuntimeFrame url={runtime} title="Notes" canOpenExternalUrl={() => true} />);
    navigate("https://help.example/");
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("This link is unavailable in this app preview.")).toBeTruthy();
    expect(log).toHaveBeenCalledWith("[mobile] external app link unavailable", "Error");
  });
});
