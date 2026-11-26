// @vitest-environment jsdom
// This device's own ids, which its Terminal views leave out of the computer's desktops
// (spec 2716). Fault detected (review): they were read once, so pairing this device from
// the Terminal window while a Terminal view was open listed this device under Desktops.
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useThisDevice } from "@desktop/renderer/src/features/terminal/ElectronDesktopMachines";

const DEVICE = "a".repeat(64);
const listeners = new Map<string, Array<(payload: unknown) => void>>();
let deviceIds: string[] = [];

beforeEach(() => {
  listeners.clear();
  deviceIds = [];
  window.operator = {
    invoke: vi.fn(async () => ({ deviceIds })),
    on: (channel, callback) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), callback]);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((entry) => entry !== callback));
    },
  };
});

describe("this device's ids", () => {
  it("are read again when the link changes", async () => {
    const { result } = renderHook(() => useThisDevice());
    await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledTimes(1));
    expect(result.current).toEqual([]);
    deviceIds = [DEVICE];
    act(() => { for (const listener of listeners.get("desktop-link:changed") ?? []) listener({}); });
    await waitFor(() => expect(result.current).toEqual([DEVICE]));
  });

  it("are read again when the desktops listed change", async () => {
    const { result, rerender } = renderHook(({ listed }) => useThisDevice(listed), { initialProps: { listed: "" } });
    await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledTimes(1));
    deviceIds = [DEVICE];
    rerender({ listed: DEVICE });
    await waitFor(() => expect(result.current).toEqual([DEVICE]));
  });
});
