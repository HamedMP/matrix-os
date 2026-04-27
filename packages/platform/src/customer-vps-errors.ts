export type CustomerVpsFailureCode =
  | 'quota_exceeded'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'r2_unavailable'
  | 'invalid_state'
  | 'not_found'
  | 'registration_rejected'
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
