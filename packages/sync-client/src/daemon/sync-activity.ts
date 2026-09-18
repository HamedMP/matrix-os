/** Process-local activity. Overflow stays degraded until a full startup reconciliation. */
export function createSyncActivity() {
  let active = 0;
  let overflow = false;
  const failures = new Set<string>();
  return {
    activeTransferCount: () => active,
    pendingFailureCount: () => failures.size + Number(overflow),
    begin() {
      active++;
      let ended = false;
      return () => { if (!ended) { ended = true; active--; } };
    },
    failed(key: string) {
      if (failures.size < 1000 || failures.has(key)) failures.add(key);
      else overflow = true;
    },
    succeeded(key: string) { failures.delete(key); },
  };
}
