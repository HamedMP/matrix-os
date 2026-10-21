/** Shared accessible status for provider discovery and revalidation. */
export function ChatProviderLoadingIndicator() {
  return <span role="status" aria-label="Checking model availability" className="matrix-chat-provider-loading">
    <svg className="matrix-chat-provider-loading-spinner" aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity=".25" />
      <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  </span>;
}
