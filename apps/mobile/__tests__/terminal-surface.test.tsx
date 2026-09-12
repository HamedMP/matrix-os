import React from "react";
import { act, render, screen } from "@testing-library/react-native";

const mockInjectJavaScript = jest.fn();

jest.mock("react-native-webview", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    WebView: React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
      React.useImperativeHandle(ref, () => ({ injectJavaScript: mockInjectJavaScript }));
      return React.createElement(View, { ...props, testID: "terminal-webview" });
    }),
  };
});

import { TerminalSurface } from "../components/TerminalSurface";

describe("native mobile terminal surface", () => {
  it("forwards xterm onBinary protocol bytes through the React Native bridge", () => {
    const onBinary = jest.fn();
    render(
      <TerminalSurface
        fontScale={1}
        onInput={jest.fn()}
        onBinary={onBinary}
        onResize={jest.fn()}
      />,
    );

    const webView = screen.getByTestId("terminal-webview");
    expect(webView.props.source.html).toContain("term.onBinary(function (data)");

    act(() => webView.props.onMessage({
      nativeEvent: { data: JSON.stringify({ type: "binary", data: "\x1b]10;?\x07\x80\xff" }) },
    }));

    expect(onBinary).toHaveBeenCalledWith("\x1b]10;?\x07\x80\xff");
  });
});
