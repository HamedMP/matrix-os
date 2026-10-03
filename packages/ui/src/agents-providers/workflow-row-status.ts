/** Mounted rows share progress without clearing another row's active operation. */
export function updateWorkflowRowStatus(current: Record<string, string>, id: string, status: string | null): Record<string, string> {
  if (current[id] === status || (!status && !(id in current))) return current;
  const next = { ...current };
  if (!status) delete next[id];
  else if (id in next || Object.keys(next).length < 32) next[id] = status;
  return next;
}
