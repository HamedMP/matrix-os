import type { TerminalRef } from '@matrix-os/contracts';
import { terminalTabIncarnation } from './incarnation.js';
import type { TerminalWorkspaceStore } from './workspace-store.js';

/** The caller serializes workspace mutation; reject identity drift around the read too. */
export async function readTerminalCommandObservation<T>(input: {
  store: Pick<TerminalWorkspaceStore, 'getRuntimeWorkspace'>;
  ref: TerminalRef;
  expectedIncarnation?: string;
  observe(sessionName: string, tabId: number, paneId: string): Promise<T>;
}): Promise<T | undefined> {
  const workspace = await input.store.getRuntimeWorkspace(input.ref.workspaceId);
  const tab = workspace?.tabs[input.ref.tabId];
  // A Zellij pane observes the I/O helper, never the native harness exit code.
  if (tab?.nativeHost) return undefined;
  if (!workspace || !tab || tab.zellijTabId === null || tab.zellijPaneId === null) return undefined;
  const incarnation = terminalTabIncarnation(tab);
  if (input.expectedIncarnation && incarnation !== input.expectedIncarnation) return undefined;
  const result = await input.observe(workspace.zellijSessionName, tab.zellijTabId, tab.zellijPaneId);
  const current = (await input.store.getRuntimeWorkspace(input.ref.workspaceId))?.tabs[input.ref.tabId];
  if (!current || terminalTabIncarnation(current) !== incarnation || current.zellijTabId !== tab.zellijTabId
    || current.zellijPaneId !== tab.zellijPaneId) return undefined;
  return result;
}
