// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { wireNativeAppOpening } from "../../desktop/src/renderer/src/lib/native-app-opening";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import type { EventPayload } from "../../desktop/src/shared/ipc-contract";

const native = vi.hoisted(() => ({ onEvent: vi.fn() }));
vi.mock("../../desktop/src/renderer/src/lib/operator", () => ({ invoke: vi.fn(), onEvent: native.onEvent }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
it("opens a normal installed-app tab only in the matching signed-in scope and removes its listener", () => {
  const cleanup = vi.fn(); native.onEvent.mockReturnValue(cleanup);
  const openTab = vi.fn(); useTabs.setState({ openTab });
  useConnection.setState({ status: "signed-in", runtimeSlot: "primary", authGeneration: 7 });
  const dispose = wireNativeAppOpening();
  const [channel, receive] = native.onEvent.mock.calls[0] as [string, (event: EventPayload<"app:open">) => void];
  expect(channel).toBe("app:open");
  const event = { slug: "planner", name: "Planner", appIdentity: "owner/planner", runtimeSlot: "primary", authGeneration: 7 };
  receive(event);
  expect(openTab).toHaveBeenCalledWith({ kind: "app", slug: "planner", title: "Planner", appIdentity: "owner/planner" });
  receive({ ...event, runtimeSlot: "other" }); receive({ ...event, authGeneration: 6 });
  useConnection.setState({ status: "signed-out" }); receive(event);
  expect(openTab).toHaveBeenCalledTimes(1);
  dispose(); expect(cleanup).toHaveBeenCalledOnce();
});
