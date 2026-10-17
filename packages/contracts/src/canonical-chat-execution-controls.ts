import type { CanonicalChatModelSelection, CanonicalChatRun } from "#canonical-chat";
import type { CanonicalProviderCatalog } from "#canonical-chat-provider";

/** Presentation of accepted owner intent, never an authorization or tool grant. */
export interface CanonicalChatExecutionControls {
  chatId: string;
  runId: string;
  selection: CanonicalChatModelSelection;
  interactionMode: string;
  permissionMode: string;
}

function sameSelection(a: CanonicalChatModelSelection, b: CanonicalChatModelSelection): boolean {
  const left = a.options ?? [];
  const right = b.options ?? [];
  return a.instanceId === b.instanceId && a.model === b.model && left.length === right.length
    && left.every(option => right.some(candidate => candidate.id === option.id && candidate.value === option.value));
}

function compareRuns(a: CanonicalChatRun, b: CanonicalChatRun): number {
  return a.historyBoundarySeq - b.historyBoundarySeq || a.attempt - b.attempt
    || Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

/** Use the latest admitted run, including a failed one; never search back for a more permissive matching run. */
export function canonicalChatExecutionControls(context: {
  chatId: string;
  currentSelection?: CanonicalChatModelSelection;
  runs: readonly CanonicalChatRun[];
}): CanonicalChatExecutionControls | undefined {
  const { chatId, currentSelection, runs } = context;
  if (!currentSelection) return undefined;
  const candidates = runs.filter(run => run.chatId === chatId);
  const latest = candidates.reduce<CanonicalChatRun | undefined>((current, run) => (
    !current || compareRuns(run, current) > 0 ? run : current
  ), undefined);
  if (!latest || !sameSelection(latest.selection, currentSelection)
    || candidates.some(run => run.id !== latest.id && compareRuns(run, latest) === 0)) return undefined;
  return { chatId, runId: latest.id, selection: latest.selection,
    interactionMode: latest.interactionMode, permissionMode: latest.permissionMode };
}

/** Every renderer checks restored intent against today's catalog; the gateway still validates every admission. */
export function canonicalChatTurnModes(
  catalog: CanonicalProviderCatalog | null,
  selection: CanonicalChatModelSelection | null | undefined,
  controls?: CanonicalChatExecutionControls,
): { interactionMode: string; permissionMode: string } | null {
  if (!catalog || !selection) return null;
  const instance = catalog.instances.find(candidate => candidate.id === selection.instanceId);
  if (!instance) return null;
  const saved = controls && sameSelection(controls.selection, selection) ? controls : undefined;
  const interactionMode = saved && instance.supports.interactionModes.includes(saved.interactionMode)
    ? saved.interactionMode : instance.supports.interactionModes.includes("default")
      ? "default" : instance.supports.interactionModes[0];
  const permissionMode = saved && instance.supports.permissionModes.includes(saved.permissionMode)
    ? saved.permissionMode : instance.supports.permissionModes.includes("supervised")
      ? "supervised" : instance.supports.permissionModes[0];
  return interactionMode && permissionMode ? { interactionMode, permissionMode } : null;
}
