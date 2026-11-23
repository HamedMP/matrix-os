/**
 * Agent access to the board (spec 2699 section 5, auth matrix row "Agent tools and
 * `matrix tasks` from a session"): a terminal pane's loopback token or a chat run's
 * token reaches only the routes the agent adapters use, only in the session's own
 * project, and acts as `agent:<session ref>`.
 */
import { PROJECT_TASK_SESSION_PATH } from "@matrix-os/contracts/project-tasks";

/** The session a bounded credential belongs to, resolved by the gateway, never from a body. */
export interface ProjectTaskAgentBinding {
  /** `chat_…` or `term.<workspace>.<tab>`; the actor is `agent:<ref>`. */
  ref: string;
  projectId: string;
  projectSlug: string;
  /** A discovery chat run reads the board and changes nothing. */
  readOnly: boolean;
}

const SLUG = "[a-z0-9][a-z0-9-]{0,62}";
const TASK = "task_[A-Za-z0-9_-]{1,128}";
const AGENT_ROUTES: Array<{ methods: readonly string[]; path: RegExp }> = [
  { methods: ["GET", "POST"], path: new RegExp(`^/api/projects/(${SLUG})/tasks$`) },
  { methods: ["GET", "PATCH"], path: new RegExp(`^/api/projects/(${SLUG})/tasks/${TASK}$`) },
  { methods: ["POST"], path: new RegExp(`^/api/projects/(${SLUG})/tasks/${TASK}/(?:move|start)$`) },
  { methods: ["GET", "POST"], path: new RegExp(`^/api/projects/(${SLUG})/tasks/${TASK}/comments$`) },
  { methods: ["GET"], path: new RegExp(`^/api/projects/(${SLUG})/tasks/${TASK}/activity$`) },
];

/**
 * The board routes a session credential may call: list, read, create, update, move,
 * comment, history and start work, plus its own binding. With `slug`, only that
 * project; with `readOnly`, only reads. Archive, delete, settings, attach and pull
 * requests stay owner-only.
 */
export function isProjectTaskAgentRoute(method: string, path: string, scope: { slug?: string; readOnly?: boolean } = {}): boolean {
  if (scope.readOnly && method !== "GET") return false;
  if (method === "GET" && path === PROJECT_TASK_SESSION_PATH) return true;
  return AGENT_ROUTES.some((route) => {
    if (!route.methods.includes(method)) return false;
    const match = route.path.exec(path);
    return match !== null && (scope.slug === undefined || match[1] === scope.slug);
  });
}
