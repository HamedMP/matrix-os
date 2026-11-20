import { createCodingAgentNotificationPreferenceStore } from "../coding-agents/notification-preferences.js";
import { createCodingAgentReviewSummaryStore } from "../coding-agents/review-summary.js";

/** Owner state is resolved once at registration, before routes or the legacy event bridge start. */
export function createNotificationPreferenceRuntime(options: {
  homePath: string;
  env: NodeJS.ProcessEnv;
  reviewStore: Parameters<typeof createCodingAgentReviewSummaryStore>[0];
}) {
  const ownerIds = [options.env.MATRIX_USER_ID, options.env.MATRIX_CLERK_USER_ID].filter((id): id is string => Boolean(id));
  const reviews = createCodingAgentReviewSummaryStore(options.reviewStore, {
    homePath: options.homePath, ownerId: options.env.MATRIX_USER_ID, principalOwnerIds: ownerIds,
  });
  const legacy = createCodingAgentNotificationPreferenceStore({ homePath: options.homePath, ownerIds });
  return { ownerIds, reviews, legacy };
}
