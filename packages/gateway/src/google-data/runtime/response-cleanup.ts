/** Do not wait on an untrusted cancellation implementation or retain body/cause diagnostics. */
export function discardGooglePolicyResponse(response: Response): void {
  void response.body?.cancel().catch(error => console.warn('[google-data] Response cleanup:', error instanceof Error ? error.name : 'UnknownError'));
}
