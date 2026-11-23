// Allowlisted copy for project lifecycle failures, shared by every OS view.
// Gateway codes outside this list never reach the UI.
const SAFE_ACTION_ERRORS: Record<string, string> = {
  project_active: "Stop active project work before continuing.",
  confirmation_mismatch: "Enter the exact project name to continue.",
  activity_check_failed: "Project activity could not be checked. Try again.",
  delete_incomplete: "Project deletion could not be completed. Try again.",
};

export const PROJECT_ACTIONS_UNAVAILABLE =
  "Project management is unavailable on this computer. Restart Matrix services and try again.";
export const PROJECT_UPDATE_INCOMPLETE =
  "This computer has not finished applying its update. Restart Matrix services, then try again.";
export const PROJECT_LISTS_STALE = "Project updated, but project lists could not be refreshed. Try again.";

export function projectLifecycleErrorMessage(code: string | null | undefined): string | undefined {
  return code && Object.hasOwn(SAFE_ACTION_ERRORS, code) ? SAFE_ACTION_ERRORS[code] : undefined;
}

export function projectLifecyclePath(slug: string): string {
  return `/api/projects/${encodeURIComponent(slug)}/actions`;
}
