export type OrganizationDriveErrorCode = "not_found" | "conflict" | "quota" | "checksum" | "unsupported" | "unavailable";
export class OrganizationDriveError extends Error {
  constructor(readonly code: OrganizationDriveErrorCode) { super(code); this.name = "OrganizationDriveError"; }
}
