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

import { TerminalSurface, type TerminalSurfaceHandle } from "../components/TerminalSurface";

function renderSurface(onResize = jest.fn()) {
  const ref = React.createRef<TerminalSurfaceHandle>();
  render(
    <TerminalSurface
      ref={ref}
      fontScale={1}
      onInput={jest.fn()}
      onBinary={jest.fn()}
      onResize={onResize}
    />,
  );
  const webView = screen.getByTestId("terminal-webview");
  const emulatorSays = (message: Record<string, unknown>) => act(() => webView.props.onMessage({
    nativeEvent: { data: JSON.stringify(message) },
  }));
  return { surface: ref.current!, webView, emulatorSays };
}

function injectedScripts(): string[] {
  return mockInjectJavaScript.mock.calls.map((call) => String(call[0]));
}

describe("native mobile terminal surface", () => {
  beforeEach(() => {
    mockInjectJavaScript.mockClear();
  });

  it("holds the grid and its output for an emulator that has not booted, in order", () => {
    const { surface, emulatorSays } = renderSurface();

    act(() => {
      surface.resize(120, 36);
      surface.write("first");
      surface.write("second");
    });
    expect(mockInjectJavaScript).not.toHaveBeenCalled();

    emulatorSays({ type: "ready", cols: 49, rows: 36 });

    const scripts = injectedScripts();
    expect(scripts).toHaveLength(1);
    const grid = scripts[0]!.indexOf("applyGrid(120,36)");
    const first = scripts[0]!.indexOf(JSON.stringify("first"));
    const second = scripts[0]!.indexOf(JSON.stringify("second"));
    expect(grid).toBeGreaterThanOrEqual(0);
    expect(first).toBeGreaterThan(grid);
    expect(second).toBeGreaterThan(first);
  });

  it("drops held output a reset has superseded but keeps the grid", () => {
    const { surface, emulatorSays } = renderSurface();

    act(() => {
      surface.resize(49, 36);
      surface.write("stale screen");
      surface.reset();
      surface.write("fresh screen");
    });
    emulatorSays({ type: "ready", cols: 49, rows: 36 });

    const script = injectedScripts().join(";");
    expect(script).toContain("applyGrid(49,36)");
    expect(script).toContain("fresh screen");
    expect(script).not.toContain("stale screen");
  });

  it("applies each operation as it arrives once the emulator is running", () => {
    const { surface, emulatorSays } = renderSurface();
    emulatorSays({ type: "ready", cols: 49, rows: 36 });
    mockInjectJavaScript.mockClear();

    act(() => {
      surface.resize(49, 18);
      surface.reset();
      surface.write("prompt");
    });

    const scripts = injectedScripts();
    expect(scripts).toHaveLength(3);
    expect(scripts[0]).toContain("applyGrid(49,18)");
    expect(scripts[1]).toContain("__term.reset()");
    expect(scripts[2]).toContain(JSON.stringify("prompt"));
  });

  it("refuses a grid the emulator could not hold", () => {
    const { surface, emulatorSays } = renderSurface();
    emulatorSays({ type: "ready", cols: 49, rows: 36 });
    mockInjectJavaScript.mockClear();

    act(() => {
      surface.resize(0, 36);
      surface.resize(49.5, 36);
      surface.resize(501, 36);
      surface.resize(49, 201);
    });

    expect(mockInjectJavaScript).not.toHaveBeenCalled();
  });

  it("reports the grid that fits the screen", () => {
    const onResize = jest.fn();
    const { emulatorSays } = renderSurface(onResize);

    emulatorSays({ type: "ready", cols: 49, rows: 36 });
    emulatorSays({ type: "resize", cols: 49, rows: 18 });

    expect(onResize.mock.calls).toEqual([[49, 36], [49, 18]]);
  });

  it("holds only the latest grid when several arrive before the emulator boots", () => {
    const { surface, emulatorSays } = renderSurface();

    act(() => {
      surface.resize(120, 36);
      surface.resize(49, 36);
      surface.resize(49, 18);
    });
    emulatorSays({ type: "ready", cols: 49, rows: 36 });

    const script = injectedScripts().join(";");
    expect(script.match(/applyGrid\(/g)).toHaveLength(1);
    expect(script).toContain("applyGrid(49,18)");
  });

  it("logs a fault the emulator reports, by its place and error name only", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const { emulatorSays } = renderSurface();

    emulatorSays({ type: "fault", where: "apply-grid", name: "RangeError" });

    expect(warn).toHaveBeenCalledWith("[mobile] terminal emulator fault", "apply-grid", "RangeError");
    warn.mockRestore();
  });

  it("does not echo arbitrary text from the emulator page into the log", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const { emulatorSays } = renderSurface();

    emulatorSays({ type: "fault", where: "/home/matrix/secret", name: "x".repeat(400) });
    emulatorSays({ type: "fault", where: "measure", name: "Bearer abc.def" });

    expect(warn.mock.calls).toEqual([
      ["[mobile] terminal emulator fault", "unknown", "Error"],
      ["[mobile] terminal emulator fault", "measure", "Error"],
    ]);
    warn.mockRestore();
  });

  it("reports failures on the grid paths and only counts a grid that was applied", () => {
    const { webView } = renderSurface();
    const html = String(webView.props.source.html);

    expect(html).toContain('reportFault("measure", e)');
    expect(html).toContain('reportFault("fit", e)');
    expect(html).toContain('reportFault("apply-grid", e)');
    // A resize that throws returns before the grid is marked as applied, so
    // the emulator keeps fitting itself instead of sitting on a grid it lacks.
    const applyGrid = html.slice(html.indexOf("applyGrid: function"), html.indexOf("focus: function"));
    expect(applyGrid.indexOf('reportFault("apply-grid", e)')).toBeGreaterThan(-1);
    expect(applyGrid.indexOf("return;")).toBeGreaterThan(applyGrid.indexOf('reportFault("apply-grid", e)'));
    expect(applyGrid.indexOf("gridApplied = true")).toBeGreaterThan(applyGrid.indexOf("return;"));
  });

  it("measures the screen without resizing a grid the computer owns", () => {
    const { webView } = renderSurface();
    const html = String(webView.props.source.html);

    // The fit addon may only propose a size. Refitting the emulator itself
    // while the computer still draws for its own grid scrolls the screen away.
    expect(html).toContain("fit.proposeDimensions()");
    expect(html).not.toContain("fit.fit()");
    expect(html).toContain("if (!gridApplied)");
  });

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
