const SAFE_RUNTIME_SLOT = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MAX_RUNTIME_NAME_LENGTH = 32;

export type RuntimeNameValidation =
  | { valid: true; slot: string; title: string }
  | { valid: false; error: string; slot: string };

export function normalizeRuntimeSlotName(value: string): string {
  return value
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function runtimeSlotTitle(slot: string): string {
  return slot
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function validateRuntimeName(
  value: string,
  existingSlots: readonly string[],
): RuntimeNameValidation {
  const trimmed = value.trim();
  const slot = normalizeRuntimeSlotName(value);
  if (trimmed.length > MAX_RUNTIME_NAME_LENGTH) {
    return { valid: false, error: "Use 32 characters or fewer.", slot };
  }
  if (!slot || !SAFE_RUNTIME_SLOT.test(slot)) {
    return { valid: false, error: "Enter a name with at least one letter or number.", slot };
  }
  if (slot === "primary") {
    return { valid: false, error: "Primary is reserved for your main computer.", slot };
  }
  if (existingSlots.includes(slot)) {
    return { valid: false, error: "A computer already uses that name.", slot };
  }
  return { valid: true, slot, title: runtimeSlotTitle(slot) };
}
