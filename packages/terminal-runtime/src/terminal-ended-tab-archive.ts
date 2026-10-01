import { SafeDisplayStringSchema, TerminalRefSchema, type TerminalRef, type TerminalTab } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { TerminalRuntimeError } from "./errors.js";
import { terminalTabIncarnation } from "./incarnation.js";
import type { ZellijRuntimeAdapter } from "./runtime.js";
import type { TerminalWorkspaceStore } from "./workspace-store.js";

export const TerminalEndedTabArchiveInputSchema = z.object({
  name: SafeDisplayStringSchema,
  expectedName: SafeDisplayStringSchema,
  providerId: z.enum(["claude", "codex"]),
  expectedIncarnation: z.string().regex(/^ti_[a-f0-9]{32}$/),
  baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
export type TerminalEndedTabArchiveInput = z.infer<typeof TerminalEndedTabArchiveInputSchema>;
export const TerminalEndedTabArchiveRequestSchema = TerminalRefSchema.extend(TerminalEndedTabArchiveInputSchema.shape).strict();

export const ArchiveTabInventorySchema = z.array(z.object({
  tab_id: z.number().int().min(0), name: z.string().max(128),
}).passthrough()).max(10_000);
export const ArchivePaneInventorySchema = z.array(z.object({
  id: z.number().int().min(0), tab_id: z.number().int().min(0), is_plugin: z.boolean(),
}).passthrough()).max(10_000);

export function archivedTabRuntimeIdentity(tabsRaw: unknown, panesRaw: unknown, internalName: string,
  expected?: { tabId: number | null; paneId: string | null }) {
  const inventory = ArchiveTabInventorySchema.parse(tabsRaw);
  const tabs = inventory.filter((tab) => tab.name === internalName);
  const allPanes = ArchivePaneInventorySchema.parse(panesRaw);
  if (expected && (inventory.some((tab) => tab.tab_id === expected.tabId && tab.name !== internalName)
    || allPanes.some((pane) => !pane.is_plugin && `terminal_${pane.id}` === expected.paneId
      && pane.tab_id !== expected.tabId))) throw new TerminalRuntimeError("conflict");
  if (tabs.length === 0) {
    if (expected && (inventory.some((tab) => tab.tab_id === expected.tabId)
      || allPanes.some((pane) => !pane.is_plugin && `terminal_${pane.id}` === expected.paneId))) {
      throw new TerminalRuntimeError("conflict");
    }
    return undefined;
  }
  if (tabs.length !== 1) throw new TerminalRuntimeError("unavailable");
  if (expected && expected.tabId !== null && tabs[0]!.tab_id !== expected.tabId) throw new TerminalRuntimeError("conflict");
  const panes = allPanes.filter((pane) => !pane.is_plugin && pane.tab_id === tabs[0]!.tab_id);
  if (panes.length === 0) return undefined;
  if (panes.length !== 1) throw new TerminalRuntimeError("unavailable");
  return { tabId: tabs[0]!.tab_id, paneId: `terminal_${panes[0]!.id}` };
}

/** Called under workspace admission and the input gate; preserves every physical pane and its immutable identity. */
export async function archiveEndedTerminalTab(
  store: TerminalWorkspaceStore,
  zellij: ZellijRuntimeAdapter,
  ref: TerminalRef,
  input: TerminalEndedTabArchiveInput,
): Promise<TerminalTab> {
  const workspace = await store.getRuntimeWorkspace(ref.workspaceId);
  const tab = workspace?.tabs[ref.tabId];
  if (!workspace || !tab) throw new TerminalRuntimeError("not_found");
  if (tab.agent?.providerId !== input.providerId) throw new TerminalRuntimeError("unavailable");
  if (tab.name !== input.expectedName || tab.revision !== input.baseRevision
    || terminalTabIncarnation(tab) !== input.expectedIncarnation) throw new TerminalRuntimeError("conflict");
  if (!zellij.findTabByInternalNameReadOnly) throw new TerminalRuntimeError("unavailable");
  // Only a successful authoritative inventory may establish absence. Query errors propagate safely.
  const found = await zellij.findTabByInternalNameReadOnly(workspace.zellijSessionName, tab.zellijTabName,
    { tabId: tab.zellijTabId, paneId: tab.zellijPaneId });
  if (found) {
    if (found.tabId !== tab.zellijTabId || found.paneId !== tab.zellijPaneId) throw new TerminalRuntimeError("conflict");
    if (!zellij.getCommandState || await zellij.getCommandState(
      workspace.zellijSessionName, found.tabId, found.paneId,
    ) !== "exited") throw new TerminalRuntimeError("unavailable");
  }
  // The store revalidates identity and revision and claims the destination in its serialized write.
  return store.archiveEndedTab(ref, input);
}
