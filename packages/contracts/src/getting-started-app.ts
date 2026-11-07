/**
 * Getting started desktop app (spec 639): the ten tasks, their points, and
 * the shared status derivation. Completion signals reuse the popover's
 * checks in getting-started.ts so both surfaces agree.
 */
import { z } from "zod/v4";
import {
  gettingStartedAiProviderStatus,
  gettingStartedChatStatus,
  gettingStartedGithubStatus,
  gettingStartedServicesStatus,
  type GettingStartedResults,
  type GettingStartedStepStatus,
} from "#getting-started";

export const GETTING_STARTED_APP_TASK_IDS = [
  "first-prompt",
  "build-app",
  "create-agent",
  "build-memory",
  "slack",
  "whatsapp",
  "github",
  "ai-provider",
  "mobile-app",
  "invite-friends",
] as const;

export type GettingStartedAppTaskId = (typeof GETTING_STARTED_APP_TASK_IDS)[number];
export type GettingStartedAppTaskGroup = "hero" | "build" | "connect" | "further";

export interface GettingStartedAppTaskDefinition {
  id: GettingStartedAppTaskId;
  group: GettingStartedAppTaskGroup;
  title: string;
  description: string;
  /** Points per award; Invite friends pays this per friend once referrals exist. */
  points: number;
  /** Toast copy when the task turns Done, e.g. "Slack connected". */
  doneMessage: string;
}

export const GETTING_STARTED_APP_TASKS: readonly GettingStartedAppTaskDefinition[] = Object.freeze([
  { id: "first-prompt", group: "hero", title: "Put your agent to work", description: "Ask Matrix to make something for you. About 2 minutes.", points: 50, doneMessage: "First task started" },
  { id: "build-app", group: "build", title: "Build an app", description: "Describe it, Matrix builds it.", points: 30, doneMessage: "App built" },
  { id: "create-agent", group: "build", title: "Create an agent", description: "A teammate that works 24/7.", points: 30, doneMessage: "Agent created" },
  { id: "build-memory", group: "build", title: "Build your memory", description: "Teach Matrix what matters to you.", points: 30, doneMessage: "Memory started" },
  { id: "slack", group: "connect", title: "Slack", description: "Send work to Matrix from Slack.", points: 20, doneMessage: "Slack connected" },
  { id: "whatsapp", group: "connect", title: "WhatsApp", description: "Chat with Matrix on the go.", points: 20, doneMessage: "WhatsApp connected" },
  { id: "github", group: "connect", title: "GitHub", description: "Let agents work in your repos.", points: 20, doneMessage: "GitHub connected" },
  { id: "ai-provider", group: "connect", title: "AI provider", description: "Bring your own model key.", points: 20, doneMessage: "AI provider connected" },
  { id: "mobile-app", group: "further", title: "Get the mobile app", description: "Matrix in your pocket.", points: 20, doneMessage: "Mobile app connected" },
  { id: "invite-friends", group: "further", title: "Invite friends", description: "For each friend who joins.", points: 100, doneMessage: "Friend joined" },
]);

/** Invite friends pays per friend and needs referrals (GTM-529), so it is not awarded here. */
export const GETTING_STARTED_APP_AWARDABLE_TASK_IDS = GETTING_STARTED_APP_TASK_IDS.filter(
  (id): id is Exclude<GettingStartedAppTaskId, "invite-friends"> => id !== "invite-friends",
);

export type GettingStartedAppAwardableTaskId = (typeof GETTING_STARTED_APP_AWARDABLE_TASK_IDS)[number];

const TASKS_BY_ID = new Map(GETTING_STARTED_APP_TASKS.map((task) => [task.id, task]));

export function gettingStartedAppTaskPoints(id: GettingStartedAppTaskId): number {
  return TASKS_BY_ID.get(id)?.points ?? 0;
}

export function gettingStartedAppTask(id: GettingStartedAppTaskId): GettingStartedAppTaskDefinition {
  const task = TASKS_BY_ID.get(id);
  if (!task) throw new Error(`Unknown Getting started task: ${id}`);
  return task;
}

export interface GettingStartedAppTask extends GettingStartedAppTaskDefinition {
  status: GettingStartedStepStatus;
}

/**
 * Tasks without a reliable signal yet stay "unavailable" and are never
 * marked Done by guesswork (spec 639, open questions 4-5).
 */
export function deriveGettingStartedAppTasks(results: GettingStartedResults): GettingStartedAppTask[] {
  const statuses: Record<GettingStartedAppTaskId, GettingStartedStepStatus> = {
    "first-prompt": gettingStartedChatStatus(results),
    "build-app": "unavailable",
    "create-agent": "unavailable",
    "build-memory": "unavailable",
    slack: gettingStartedServicesStatus(results, ["slack"]),
    whatsapp: "unavailable",
    github: gettingStartedGithubStatus(results),
    "ai-provider": gettingStartedAiProviderStatus(results),
    "mobile-app": "unavailable",
    "invite-friends": "unavailable",
  };
  return GETTING_STARTED_APP_TASKS.map((task) => ({ ...task, status: statuses[task.id] }));
}

/** The hero's "Up next": the first incomplete task in grid order. */
export function gettingStartedAppNextTask(tasks: readonly GettingStartedAppTask[]): GettingStartedAppTask | null {
  return tasks.find((task) => task.status === "incomplete") ?? null;
}

const AwardableTaskIdSchema = z.enum(GETTING_STARTED_APP_AWARDABLE_TASK_IDS);

export const GettingStartedAppAwardRequestSchema = z.object({
  taskId: AwardableTaskIdSchema,
  /** Already done when first seen: recorded without a toast. */
  silent: z.boolean(),
}).strict();

export type GettingStartedAppAwardRequest = z.infer<typeof GettingStartedAppAwardRequestSchema>;

const PointsSchema = z.number().int().min(0).max(100_000);

/**
 * Responses can come from a newer computer than this client: Electron updates apart from the
 * gateway. Ids this build does not know and added fields must not reject the whole response, so
 * the task id is only checked for shape here (matching the table's CHECK) and clients keep the
 * ids they know with `gettingStartedAppKnownTaskIds`. Requests stay strict.
 */
const StoredTaskIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);
const MAX_PROGRESS_AWARDS = 64;

export const GettingStartedAppAwardSchema = z.object({
  taskId: StoredTaskIdSchema,
  points: PointsSchema,
  awardedAt: z.string().datetime(),
});

export type GettingStartedAppAward = z.infer<typeof GettingStartedAppAwardSchema>;

export const GettingStartedAppProgressSchema = z.object({
  awards: z.array(GettingStartedAppAwardSchema).max(MAX_PROGRESS_AWARDS),
  total: PointsSchema,
});

export type GettingStartedAppProgress = z.infer<typeof GettingStartedAppProgressSchema>;

/** The awarded tasks this build knows; a newer computer's other tasks still count in `total`. */
export function gettingStartedAppKnownTaskIds(awards: readonly { taskId: string }[]): GettingStartedAppTaskId[] {
  const known = new Set<string>(GETTING_STARTED_APP_TASK_IDS);
  return awards.flatMap(({ taskId }) => (known.has(taskId) ? [taskId as GettingStartedAppTaskId] : []));
}

export const GettingStartedAppAwardResponseSchema = z.object({
  awarded: z.boolean(),
  points: PointsSchema,
  total: PointsSchema,
});

export type GettingStartedAppAwardResponse = z.infer<typeof GettingStartedAppAwardResponseSchema>;

export const GettingStartedAppAutoOpenResponseSchema = z.object({
  open: z.boolean(),
});

export type GettingStartedAppAutoOpenResponse = z.infer<typeof GettingStartedAppAutoOpenResponseSchema>;

export const GettingStartedAppDesktopIconResponseSchema = z.object({
  placed: z.boolean(),
});

export type GettingStartedAppDesktopIconResponse = z.infer<typeof GettingStartedAppDesktopIconResponseSchema>;
