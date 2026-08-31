// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCanvasTransform } from "../../shell/src/hooks/useCanvasTransform";
import { useCanvasTransformPersistence } from "../../shell/src/hooks/useOsViewStatePersistence";
import { resetWebOsViewStateClientForTests } from "../../shell/src/lib/os-view-state-client";
import { useDesktopMode } from "../../shell/src/stores/desktop-mode";

describe("Web Canvas OS-view persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetWebOsViewStateClientForTests();
    useDesktopMode.setState({ mode: "canvas", previousMode: null, _hydrated: true });
    useCanvasTransform.setState({ zoom: 1, panX: 0, panY: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries the latest transform after a persistence failure", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useCanvasTransformPersistence("http://gateway.test"));

    act(() => useCanvasTransform.getState().setTransform(0.75, -120, 48));
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).patch.canvas.transform).toEqual({
      zoom: 0.75,
      panX: -120,
      panY: 48,
    });
  });
});
