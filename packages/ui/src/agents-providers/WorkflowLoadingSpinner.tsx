/** Same ring treatment as the shared provider-loading indicator; status owns the accessible label. */
export function WorkflowLoadingSpinner() {
  return <svg className="matrix-ap-loading-spinner" aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity=".25" />
    <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>;
}
