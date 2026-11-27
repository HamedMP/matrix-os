/** Operator-only immutable Clerk identities; no email, header or external-account inference. */
export function loadNativeGmailPilotIds(raw: string | undefined): readonly string[] {
  if (raw !== undefined && raw.length > 12_899) throw new Error('Invalid Gmail pilot configuration');
  if (!raw?.trim()) return Object.freeze([]);
  const ids = raw.split(',').map(value => value.trim());
  if (ids.length > 100 || ids.some((id, index) => id.length > 128 || !/^user_[A-Za-z0-9]+$/.test(id) || ids.indexOf(id) !== index))
    throw new Error('Invalid Gmail pilot configuration');
  return Object.freeze(ids);
}
