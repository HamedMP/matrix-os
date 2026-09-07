export type CustomerVpsFailureCode =
  | 'quota_exceeded'
  | 'snapshot_quota_exceeded'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'snapshot_clone_rejected'
  | 'user_data_too_large'
  | 'r2_unavailable'
  | 'invalid_state'
  | 'billing_required'
  | 'not_found'
  | 'registration_rejected'
  | 'registration_timeout'
  | 'retry_exhausted'
  | 'unknown';

export class CustomerVpsError extends Error {
  readonly status: number;
  readonly code: CustomerVpsFailureCode;
  readonly publicMessage: string;

  constructor(status: number, code: CustomerVpsFailureCode, publicMessage: string) {
    super(publicMessage);
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

export type PreviewSnapshotUnavailableReason =
  | 'bundle_resolution_failed'
  | 'bundle_url_unpinnable'
  | 'existing_machine_snapshot_mismatch'
  | 'snapshot_binding_failed'
  | 'persisted_snapshot_missing'
  | 'persisted_provider_image_missing'
  | 'persisted_provider_image_unavailable'
  | 'persisted_snapshot_not_ready'
  | 'persisted_snapshot_ready_at_missing'
  | 'persisted_snapshot_stale'
  | 'persisted_bundle_version_mismatch'
  | 'persisted_bundle_digest_mismatch'
  | 'pre_create_snapshot_changed'
  | 'create_intent_unavailable'
  | 'create_intent_denied'
  | 'provider_create_action_rejected';

/**
 * Carries a bounded, non-secret diagnostic for server-side logging while the
 * public error contract stays deliberately generic.
 */
export class PreviewSnapshotUnavailableError extends CustomerVpsError {
  readonly internalReason: PreviewSnapshotUnavailableReason;

  constructor(internalReason: PreviewSnapshotUnavailableReason) {
    super(409, 'snapshot_clone_rejected', 'Provisioning image unavailable');
    this.name = 'PreviewSnapshotUnavailableError';
    this.internalReason = internalReason;
  }
}

/**
 * The provider returned a bounded HTTP rejection, proving that create did not
 * have an ambiguous transport outcome. Callers may retry or fail without an
 * orphan-discovery delay; the raw provider response remains server-side only.
 */
export class DefinitiveProviderRejectionError extends CustomerVpsError {
  constructor(
    status: number,
    code: CustomerVpsFailureCode,
    publicMessage: string,
  ) {
    super(status, code, publicMessage);
    this.name = 'DefinitiveProviderRejectionError';
  }
}

export function genericProviderError(err: unknown): CustomerVpsError {
  if (err instanceof CustomerVpsError) return err;
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return new CustomerVpsError(500, 'provider_timeout', 'Provisioning provider unavailable');
  }
  return new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
}

export function logCustomerVpsError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const internalReason = err instanceof PreviewSnapshotUnavailableError
    ? ` internalReason=${err.internalReason}`
    : '';
  console.error(`[customer-vps] ${context}: ${message}${internalReason}`);
}
