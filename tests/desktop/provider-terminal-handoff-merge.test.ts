import { afterEach, expect, it, vi } from "vitest";
import { openExistingProviderTerminalSession } from "../../desktop/src/renderer/src/features/settings/provider-settings-desktop-adapter";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";
import { useShellSessions } from "../../desktop/src/renderer/src/stores/shell-sessions";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";

const reference = "tws_11111111111111111111111111111111:tt_22222222222222222222222222222222";
afterEach(() => vi.useRealTimers());
it("does not retry past a newer completed missing snapshot during the discovery wait", async () => {
  vi.useFakeTimers();
  useShellSessions.setState({ sessions: [], loading: false, error: null, loadSequence: 0, authoritativeRevision: 0 });
  useTabs.setState({ tabs: [], terminalSessionRequest: null });
  const get = vi.fn().mockResolvedValue({ workspaces: [] });
  const client = { get } as unknown as ApiClient;
  const opening = openExistingProviderTerminalSession(client, reference);
  await vi.advanceTimersByTimeAsync(0);
  await useShellSessions.getState().load(client);
  get.mockResolvedValue({ workspaces: [{ id: reference.split(":")[0], revision: 1,
    tabs: [{ id: reference.split(":")[1], revision: 1, name: "provider-login", cwd: "projects", status: "running" }] }] });
  await vi.runAllTimersAsync();
  expect(await opening).toBe(false);
  expect(get).toHaveBeenCalledTimes(2);
  expect(useTabs.getState().terminalSessionRequest).toBeNull();
});
