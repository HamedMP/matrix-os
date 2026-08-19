// @vitest-environment jsdom
import React, { useRef } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTerminalFocusRequest } from "../../shell/src/components/terminal/useTerminalFocusRequest.js";

function FocusHarness({
  focus,
  focusRequestId,
  isFocused = true,
  suppressNativeKeyboard = false,
}: {
  focus: () => void;
  focusRequestId: number;
  isFocused?: boolean;
  suppressNativeKeyboard?: boolean;
}) {
  const terminalRef = useRef({ focus });
  useTerminalFocusRequest(terminalRef, focusRequestId, isFocused, suppressNativeKeyboard);
  return null;
}

function UnknownTerminalHarness({ terminal }: { terminal: unknown }) {
  const terminalRef = useRef<unknown>(terminal);
  useTerminalFocusRequest(terminalRef, 1, true, false);
  return null;
}

describe("useTerminalFocusRequest", () => {
  it("refocuses an already-focused terminal only for a new focus request", () => {
    const focus = vi.fn();
    const { rerender } = render(<FocusHarness focus={focus} focusRequestId={0} />);

    expect(focus).toHaveBeenCalledOnce();

    rerender(<FocusHarness focus={focus} focusRequestId={0} />);
    expect(focus).toHaveBeenCalledOnce();

    rerender(<FocusHarness focus={focus} focusRequestId={1} />);
    expect(focus).toHaveBeenCalledTimes(2);
  });

  it("does not claim native keyboard focus for inactive or mobile terminals", () => {
    const focus = vi.fn();
    const { rerender } = render(
      <FocusHarness focus={focus} focusRequestId={0} isFocused={false} />,
    );

    rerender(
      <FocusHarness focus={focus} focusRequestId={1} suppressNativeKeyboard />,
    );

    expect(focus).not.toHaveBeenCalled();
  });

  it("safely ignores a terminal ref that is not focusable yet", () => {
    expect(() => render(<UnknownTerminalHarness terminal={{}} />)).not.toThrow();
  });
});
