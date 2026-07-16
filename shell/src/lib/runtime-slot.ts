export const SAFE_RUNTIME_SLOT = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function parseRuntimeSlot(value: string | null | undefined): string | null {
  if (!value || value.length > 32 || !SAFE_RUNTIME_SLOT.test(value)) return null;
  return value;
}
