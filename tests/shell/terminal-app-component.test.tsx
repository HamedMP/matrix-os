// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

const paneGridSpy = vi.fn();

vi.mock("../../shell/src/components/terminal/PaneGrid.js", () => ({
  PaneGrid: (props: unknown) => {
    paneGridSpy(props);
    return null;
  },
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({ mode: "dark", colors: {}, fonts: {} }),
}));

import { TerminalApp } from "../../shell/src/components/terminal/TerminalApp.js";

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

describe("TerminalApp", () => {
  beforeEach(() => {
    paneGridSpy.mockReset();
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", ResizeObserverMock as unknown as typeof ResizeObserver);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists attached session ids in the saved layout", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(paneGridSpy).toHaveBeenCalled();

    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; id: string };
      onSessionAttached: (paneId: string, sessionId: string) => void;
    };

    expect(props.paneTree.type).toBe("pane");

    act(() => {
      props.onSessionAttached(props.paneTree.id, "session-123");
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const layoutPutCalls = fetchMock.mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/layout") && init?.method === "PUT"
    ));

    expect(layoutPutCalls.length).toBeGreaterThan(0);
    const latestBody = layoutPutCalls.at(-1)?.[1]?.body;
    expect(typeof latestBody).toBe("string");
    expect(JSON.parse(latestBody as string)).toMatchObject({
      tabs: [
        {
          paneTree: {
            sessionId: "session-123",
          },
        },
      ],
    });
  });
});
