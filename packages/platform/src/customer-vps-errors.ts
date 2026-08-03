export type CustomerVpsFailureCode =
  | 'quota_exceeded'
  | 'provider_unavailable'
  | 'provider_timeout'
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
  console.error(`[customer-vps] ${context}: ${message}`);
}
