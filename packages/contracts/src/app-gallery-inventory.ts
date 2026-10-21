/** Dependency-free inventory boundary shared by the Gallery and portable starters. */
export interface GalleryInventoryEntry {
  id?: string;
  service: string;
  account_label: string;
  account_email?: string | null;
  status: string;
}
function safeText(
  value: unknown,
  max: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    (allowEmpty || value.trim().length > 0) &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
/** Invalid/unavailable inventory throws; callers retain unknown availability, never []. */
export function parseGalleryInventory(raw: unknown): GalleryInventoryEntry[] {
  if (!Array.isArray(raw) || raw.length > 2000)
    throw new Error("Connection inventory unavailable");
  return raw.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Connection inventory unavailable");
    const row = value as Record<string, unknown>;
    if (
      (row.id !== undefined &&
        (typeof row.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(row.id))) ||
      !safeText(row.service, 64) ||
      !safeText(row.account_label, 160) ||
      !safeText(row.status, 64) ||
      (row.account_email != null && !safeText(row.account_email, 320, true))
    )
      throw new Error("Connection inventory unavailable");
    return {
      ...(row.id === undefined ? {} : { id: row.id as string }),
      service: row.service,
      account_label: row.account_label,
      status: row.status,
      ...(row.account_email === undefined
        ? {}
        : { account_email: row.account_email as string | null }),
    };
  });
}
