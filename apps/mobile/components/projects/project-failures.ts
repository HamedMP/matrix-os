import { ProjectRequestError } from "@/lib/requests/projects";

const NAME_TAKEN = "A project with that name already exists.";
const WORK_RUNNING = "This project has work running. Try again when it finishes.";

/** The line under the name field after a failed create or rename. `fallback` covers every reason but a taken name. */
export function projectNameFailure(failure: unknown, fallback: string): string {
  return failure instanceof ProjectRequestError && failure.reason === "name_taken" ? NAME_TAKEN : fallback;
}

/** The title of the alert after a failed archive. */
export const ARCHIVE_FAILED_TITLE = "Project could not be archived";

/** What that alert says under its title. */
export function archiveFailureMessage(failure: unknown): string {
  return failure instanceof ProjectRequestError && failure.reason === "project_active" ? WORK_RUNNING : "Try again.";
}
