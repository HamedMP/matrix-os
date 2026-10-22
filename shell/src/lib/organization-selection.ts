const ORGANIZATION_SELECTION_KEY = "matrix.shell.selectedOrganization:";

export type OrganizationSelection = string | "personal" | null;

export function readOrganizationSelection(userId: string | null): OrganizationSelection {
  if (!userId || typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(ORGANIZATION_SELECTION_KEY + userId);
  } catch (error: unknown) {
    console.warn("[organization-selection] selection unavailable", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

export function writeOrganizationSelection(userId: string | null, selection: Exclude<OrganizationSelection, null>): void {
  if (!userId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ORGANIZATION_SELECTION_KEY + userId, selection);
  } catch (error: unknown) {
    console.warn("[organization-selection] selection could not be saved", error instanceof Error ? error.name : "UnknownError");
  }
}

export function clearOrganizationSelection(userId: string | null): void {
  if (!userId || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(ORGANIZATION_SELECTION_KEY + userId);
  } catch (error: unknown) {
    console.warn("[organization-selection] selection could not be cleared", error instanceof Error ? error.name : "UnknownError");
  }
}
