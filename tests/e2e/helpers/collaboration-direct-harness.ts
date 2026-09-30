import { createCollaborationDirectApi } from "../../../packages/ui/src/collaboration/direct-api.js";
import type { Page } from "@playwright/test";
import { collaborationSessionToken } from "../fixtures/clerk-sign-in.js";

export function createCollaborationDirectHarness(input: {
  page: Page;
  userId: string;
  platformBaseUrl: string;
}) {
  return createCollaborationDirectApi({
    platformBaseUrl: input.platformBaseUrl,
    clientOrigin: input.platformBaseUrl,
    getHeaders: async () => ({ Authorization: `Bearer ${await collaborationSessionToken(input.page, input.userId)}` }),
  });
}
