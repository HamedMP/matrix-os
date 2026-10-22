type NativeGmailOperation = 'connection_options' | 'connection_start' | 'connection_notification'
  | 'oauth_callback' | 'account_refresh' | 'consent_owner' | 'disconnect' | 'disconnect_notification';

/** OAuth/database/subscriber errors may retain tokens, codes, private labels or
 * request bodies, including in name/cause/stack. Only fixed server categories
 * cross this log boundary; never pass the original object to a logger. */
export function logNativeGmailFailure(operation: NativeGmailOperation, error: unknown): void {
  console.warn('[native-gmail]', operation, error instanceof Error ? 'operation_failed' : 'untyped_failure');
}
