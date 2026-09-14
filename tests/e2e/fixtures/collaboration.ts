import { isAbsolute } from "node:path";
import { test as base, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { z } from "zod/v4";

const RuntimeHandleSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Invalid runtime handle");

const StorageStatePathSchema = z.string()
  .min(1)
  .max(4_096)
  .refine(isAbsolute, "Storage state path must be absolute");

const CollaborationJourneyEnvironmentSchema = z.object({
  MATRIX_COLLABORATION_E2E_BASE_URL: z.url(),
  MATRIX_COLLABORATION_E2E_RUNTIME_HANDLE: RuntimeHandleSchema,
  MATRIX_COLLABORATION_E2E_OWNER_STATE: StorageStatePathSchema,
  MATRIX_COLLABORATION_E2E_EDITOR_STATE: StorageStatePathSchema,
});

export interface CollaborationJourneyEnvironment {
  baseUrl: string;
  runtimePath: string;
  ownerStorageState: string;
  editorStorageState: string;
}

export interface CollaborationJourneyActor {
  context: BrowserContext;
  page: Page;
}

export interface TwoAccountCollaborationJourney {
  owner: CollaborationJourneyActor;
  editor: CollaborationJourneyActor;
  platformUrl: string;
  runtimeUrl: string;
  close(): Promise<void>;
}

export function parseCollaborationJourneyEnvironment(
  environment: Record<string, string | undefined> = process.env,
): CollaborationJourneyEnvironment {
  const parsed = CollaborationJourneyEnvironmentSchema.parse(environment);
  const baseUrl = new URL(parsed.MATRIX_COLLABORATION_E2E_BASE_URL);
  const localHttp = baseUrl.protocol === "http:"
    && ["localhost", "127.0.0.1", "::1"].includes(baseUrl.hostname);
  if (baseUrl.username || baseUrl.password || baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash
    || (baseUrl.protocol !== "https:" && !localHttp)) {
    throw new Error("Collaboration E2E base URL must be a clean HTTPS origin or local HTTP origin");
  }
  if (baseUrl.hostname.endsWith(".matrix-os.com") && baseUrl.hostname !== "app.matrix-os.com") {
    throw new Error("Matrix runtimes use app.matrix-os.com session or /vm routes, not per-handle subdomains");
  }
  return {
    baseUrl: baseUrl.origin,
    runtimePath: `/vm/${encodeURIComponent(parsed.MATRIX_COLLABORATION_E2E_RUNTIME_HANDLE)}`,
    ownerStorageState: parsed.MATRIX_COLLABORATION_E2E_OWNER_STATE,
    editorStorageState: parsed.MATRIX_COLLABORATION_E2E_EDITOR_STATE,
  };
}

export async function createTwoAccountCollaborationJourney(
  browser: Browser,
  environment: Record<string, string | undefined> = process.env,
): Promise<TwoAccountCollaborationJourney> {
  const config = parseCollaborationJourneyEnvironment(environment);
  const [ownerContext, editorContext] = await Promise.all([
    browser.newContext({ baseURL: config.baseUrl, storageState: config.ownerStorageState }),
    browser.newContext({ baseURL: config.baseUrl, storageState: config.editorStorageState }),
  ]);
  try {
    const [ownerPage, editorPage] = await Promise.all([
      ownerContext.newPage(),
      editorContext.newPage(),
    ]);
    return {
      owner: { context: ownerContext, page: ownerPage },
      editor: { context: editorContext, page: editorPage },
      platformUrl: config.baseUrl,
      runtimeUrl: new URL(config.runtimePath, config.baseUrl).toString(),
      async close() {
        await Promise.allSettled([ownerContext.close(), editorContext.close()]);
      },
    };
  } catch (error: unknown) {
    await Promise.allSettled([ownerContext.close(), editorContext.close()]);
    throw error;
  }
}

export const collaborationTest = base.extend<{ collaborationJourney: TwoAccountCollaborationJourney }>({
  collaborationJourney: async ({ browser }, use) => {
    const journey = await createTwoAccountCollaborationJourney(browser);
    try {
      await use(journey);
    } finally {
      await journey.close();
    }
  },
});

export { expect } from "@playwright/test";
