type ProviderSettingsErrorCode = "invalid_request" | "configuration_unavailable"
  | "projection_unavailable" | "revision_conflict" | "not_found" | "account_in_use"
  | "dependency_unavailable" | "lifecycle_unavailable" | "invalid_route"
  | "idempotency_conflict" | "runtime_unavailable";

export class ProviderSettingsStoreError extends Error {
  constructor(
    readonly code: ProviderSettingsErrorCode,
    readonly status: 400 | 404 | 409 | 503,
    readonly details: { latestRevision?: number } = {},
  ) {
    super(code);
    this.name = "ProviderSettingsStoreError";
  }

  get latestRevision(): number | undefined {
    return this.details.latestRevision;
  }
}
