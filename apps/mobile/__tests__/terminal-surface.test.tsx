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
import { TAP_CURSOR_SCRIPT } from "../components/terminal/tap-cursor-script";

interface TapCursorInput {
  col: number;
  row: number;
  cursorCol: number;
  cursorRow: number;
  lineLength: number;
  widths?: number[];
  cols: number;
  scrolled: boolean;
  cursorHidden: boolean;
  applicationCursor: boolean;
}

interface FakeCell { getWidth: () => number; getChars: () => string }

// The page runs these functions as plain script; run the same text here.
const { terminalTapCursorMove, terminalRowCells } = new Function(
  `${TAP_CURSOR_SCRIPT}; return { terminalTapCursorMove, terminalRowCells };`,
)() as {
  terminalTapCursorMove: (tap: TapCursorInput) => string;
  terminalRowCells: (line: { getCell: (col: number) => FakeCell | undefined } | null, cols: number) => {
    widths: number[];
    length: number;
  };
};

// An xterm line: wide characters fill a cell of width 2 and an empty one of width 0.
function fakeLine(text: string, cols: number) {
  const cells: FakeCell[] = [];
  for (const char of text) {
    const wide = /[　-鿿]/.test(char);
    cells.push({ getWidth: () => (wide ? 2 : 1), getChars: () => char });
    if (wide) cells.push({ getWidth: () => 0, getChars: () => "" });
  }
  while (cells.length < cols) cells.push({ getWidth: () => 1, getChars: () => "" });
  return { getCell: (col: number) => cells[col] };
}

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

  it("hides the iOS form toolbar above the keyboard", () => {
    const { webView } = renderSurface();

    // Its arrows only move between form fields, and the key rows already
    // offer a way to put the keyboard away.
    expect(webView.props.hideKeyboardAccessoryView).toBe(true);
  });

  it("moves the cursor to a tapped cell on the line being typed", () => {
    const { webView } = renderSurface();
    const html = String(webView.props.source.html);
    expect(html).toContain(TAP_CURSOR_SCRIPT);
    expect(html).toContain("terminalTapCursorMove({");
    // The arrows are keys pressed for the user, not text from the emulator.
    expect(html).toContain('post({ type: "keys", data: keys })');
  });

  it("hands keys pressed for the user to onKeys, or to onInput without one", () => {
    const onInput = jest.fn();
    const onKeys = jest.fn();
    const view = render(
      <TerminalSurface fontScale={1} onInput={onInput} onBinary={jest.fn()} onKeys={onKeys} onResize={jest.fn()} />,
    );
    const say = (message: Record<string, unknown>) => act(() => screen.getByTestId("terminal-webview").props.onMessage({
      nativeEvent: { data: JSON.stringify(message) },
    }));

    say({ type: "keys", data: "\x1b[C\x1b[C" });
    expect(onKeys).toHaveBeenCalledWith("\x1b[C\x1b[C");
    expect(onInput).not.toHaveBeenCalled();
    view.unmount();

    render(<TerminalSurface fontScale={1} onInput={onInput} onBinary={jest.fn()} onResize={jest.fn()} />);
    say({ type: "keys", data: "\x1b[D" });
    expect(onInput).toHaveBeenCalledWith("\x1b[D");
  });

  describe("tap to move the cursor", () => {
    const tap: TapCursorInput = {
      col: 10,
      row: 5,
      cursorCol: 4,
      cursorRow: 5,
      lineLength: 20,
      cols: 49,
      scrolled: false,
      cursorHidden: false,
      applicationCursor: false,
    };

    it("sends one arrow per cell between the cursor and the tap", () => {
      expect(terminalTapCursorMove(tap)).toBe("\x1b[C".repeat(6));
      expect(terminalTapCursorMove({ ...tap, col: 1 })).toBe("\x1b[D".repeat(3));
    });

    it("uses the arrows the program asked for", () => {
      expect(terminalTapCursorMove({ ...tap, applicationCursor: true })).toBe("\x1bOC".repeat(6));
      expect(terminalTapCursorMove({ ...tap, col: 0, applicationCursor: true })).toBe("\x1bOD".repeat(4));
    });

    it("stops at the end of the text instead of the edge of the screen", () => {
      expect(terminalTapCursorMove({ ...tap, col: 40 })).toBe("\x1b[C".repeat(16));
      // A cursor already past the text (after a typed space) is not pulled back.
      expect(terminalTapCursorMove({ ...tap, col: 40, cursorCol: 21 })).toBe("");
    });

    it("leaves the cursor alone when the tap cannot be on the line being typed", () => {
      expect(terminalTapCursorMove({ ...tap, row: 4 })).toBe("");
      expect(terminalTapCursorMove({ ...tap, scrolled: true })).toBe("");
      expect(terminalTapCursorMove({ ...tap, cursorHidden: true })).toBe("");
      expect(terminalTapCursorMove({ ...tap, col: 4 })).toBe("");
    });

    it("counts a wide character as one press", () => {
      // Cells 6-7 and 8-9 each hold one wide character.
      const widths = [1, 1, 1, 1, 1, 1, 2, 0, 2, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
      expect(terminalTapCursorMove({ ...tap, widths, col: 10 })).toBe("\x1b[C".repeat(4));
      // A tap on the second half of a wide character lands on its start.
      expect(terminalTapCursorMove({ ...tap, widths, col: 9 })).toBe("\x1b[C".repeat(3));
      expect(terminalTapCursorMove({ ...tap, widths, cursorCol: 10, col: 6 })).toBe("\x1b[D".repeat(2));
    });

    it("measures a line with wide characters in cells", () => {
      // Ten wide characters, then five narrow ones: 25 cells, 15 characters.
      const cells = terminalRowCells(fakeLine("一二三四五六七八九十abcde", 49), 49);
      expect(cells.length).toBe(25);
      expect(cells.widths.slice(0, 4)).toEqual([2, 0, 2, 0]);

      const move = { ...tap, cursorCol: 20, lineLength: cells.length, widths: cells.widths };
      expect(terminalTapCursorMove({ ...move, col: 24 })).toBe("\x1b[C".repeat(4));
      expect(terminalTapCursorMove({ ...move, col: 3 })).toBe("\x1b[D".repeat(9));
    });

    it("treats a missing line as empty", () => {
      expect(terminalRowCells(null, 3)).toEqual({ widths: [1, 1, 1], length: 0 });
    });
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
