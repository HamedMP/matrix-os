import React from "react";
import { View } from "react-native";

// Records every injectJavaScript payload so tests can assert what was written
// into the embedded xterm.js emulator.
export const webViewInjections: string[] = [];
export let latestWebViewSource: unknown = null;

// The latest onMessage handler, so tests can simulate the embedded page posting
// frames (e.g. the user typing directly into xterm → an "input" frame).
let latestOnMessage: ((event: WebViewMessageEvent) => void) | null = null;

export function resetWebViewMock(): void {
  webViewInjections.length = 0;
  latestWebViewSource = null;
  latestOnMessage = null;
}

export function emitWebViewMessage(message: unknown): void {
  latestOnMessage?.({ nativeEvent: { data: JSON.stringify(message) } });
}

export interface WebViewMessageEvent {
  nativeEvent: { data: string };
}

interface MockWebViewProps {
  onMessage?: (event: WebViewMessageEvent) => void;
  source?: unknown;
}

export const WebView = React.forwardRef(function WebView(
  { onMessage, source }: MockWebViewProps,
  ref: React.Ref<{ injectJavaScript: (js: string) => void }>,
) {
  React.useImperativeHandle(ref, () => ({
    injectJavaScript: (js: string) => {
      webViewInjections.push(js);
    },
  }));
  // Simulate the embedded page booting and reporting its fitted grid.
  React.useEffect(() => {
    latestWebViewSource = source ?? null;
    latestOnMessage = onMessage ?? null;
    onMessage?.({ nativeEvent: { data: JSON.stringify({ type: "ready", cols: 80, rows: 24 }) } });
  }, [onMessage, source]);
  return <View testID="terminal-webview" />;
});

export default WebView;
