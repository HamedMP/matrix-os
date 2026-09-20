/**
 * Logical runtime identity (S03 seam for S05 / T026).
 *
 * Existing runtime authentication names a home `vps:<machine-uuid>`. The
 * frozen S02 contracts forbid `:` and `.` in logical runtime ids so a ticket
 * can never bind a hostname or address, so control frames use the
 * deterministic `vps-<machine-uuid>` form. S05's runtime registration
 * reuses this mapping; it is not a hostname and never resolves anything.
 */
const VPS_RUNTIME = /^vps:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const LOGICAL_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function logicalRuntimeIdFor(runtimeId: string): string | null {
  const vps = VPS_RUNTIME.exec(runtimeId);
  if (vps) return `vps-${vps[1]!.toLowerCase()}`;
  return LOGICAL_PATTERN.test(runtimeId) && !runtimeId.includes(".") ? runtimeId : null;
}
