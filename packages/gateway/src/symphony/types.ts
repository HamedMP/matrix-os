/**
 * Slim shared types used by gateway code that talks to the Elixir Symphony
 * runtime. The TypeScript orchestrator was retired in favour of the Elixir
 * runtime; these types remain because `onboarding/coding-setup.ts` and other
 * gateway callers need a stable shape for run-status reporting and project
 * selection without re-deriving Zod schemas.
 */

export type SymphonyRunStatus =
  | "queued"
  | "running"
  | "retrying"
  | "blocked"
  | "stopped"
  | "failed"
  | "handoff"
  | "completed";

export interface MatrixProjectOption {
  slug: string;
  name: string;
  repositoryUrl?: string;
  updatedAt?: string;
}
