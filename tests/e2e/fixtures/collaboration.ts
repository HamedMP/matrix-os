import { test as base, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { z } from "zod/v4";
import {
  assertCollaborationPreconditions,
  assertMultiComputerMemberPreconditions,
  loadCollaborationIdentities,
  type CollaborationActorPreconditions,
  type CollaborationIdentityEnvironment,
  type CollaborationRole,
} from "./collaboration-identities.js";
import { signInCollaborationIdentity } from "./clerk-sign-in.js";
import { createCollaborationDirectHarness } from "../helpers/collaboration-direct-harness.js";

const ROLES = ["owner", "member", "outsider", "guest"] as const;
const ComputersSchema = z.object({ items: z.array(z.object({ handle: z.string() }).passthrough()).max(20), hasMore: z.boolean() }).passthrough();
const JourneySchema = z.object({ phase: z.string().min(1) }).passthrough();
const OrganizationsSchema = z.object({ organizations: z.array(z.object({ organizationId: z.string(), role: z.string() }).passthrough()).max(1_000) }).passthrough();
const DiscoverySchema = z.object({ items: z.array(z.unknown()).max(1_000) }).passthrough();

export interface CollaborationJourneyActor {
  userId: string;
  context: BrowserContext;
  page: Page;
  direct: ReturnType<typeof createCollaborationDirectHarness>;
  preconditions: CollaborationActorPreconditions;
}

export interface FourAccountCollaborationJourney {
  config: CollaborationIdentityEnvironment;
  actors: Record<CollaborationRole, CollaborationJourneyActor>;
  multiComputerMember?: CollaborationJourneyActor;
  previewUrl: string;
  close(): Promise<void>;
}

async function getJson(request: APIRequestContext, origin: string, path: string): Promise<unknown> {
  const response = await request.get(new URL(path, origin).toString(), { timeout: 10_000, failOnStatusCode: false });
  if (!response.ok()) throw new Error("Collaboration fixture platform precondition is unavailable");
  return await response.json() as unknown;
}

async function loadPreconditions(
  context: BrowserContext,
  config: CollaborationIdentityEnvironment,
): Promise<CollaborationActorPreconditions> {
  const request = context.request;
  const [computers, journey, organizations, inbox, shared] = await Promise.all([
    getJson(request, config.baseUrl, "/api/auth/computers"),
    getJson(request, config.baseUrl, "/api/journey"),
    getJson(request, config.baseUrl, "/api/organizations"),
    getJson(request, config.baseUrl, "/api/collaboration/inbox"),
    getJson(request, config.baseUrl, "/api/collaboration/shared"),
  ]);
  const inventory = ComputersSchema.parse(computers);
  if (inventory.hasMore) throw new Error("Collaboration fixture computer inventory is incomplete");
  return {
    computers: inventory.items.map((item) => ({ handle: item.handle })),
    phase: JourneySchema.parse(journey).phase,
    organizations: OrganizationsSchema.parse(organizations).organizations,
    inboxCount: DiscoverySchema.parse(inbox).items.length,
    sharedCount: DiscoverySchema.parse(shared).items.length,
  };
}

export async function createFourAccountCollaborationJourney(
  browser: Browser,
  environment: Record<string, string | undefined> = process.env,
  viewport?: { width: number; height: number },
): Promise<FourAccountCollaborationJourney> {
  const { config, users, multiComputerMember } = await loadCollaborationIdentities(environment);
  const opened: BrowserContext[] = [];
  try {
    const actors = {} as Record<CollaborationRole, CollaborationJourneyActor>;
    for (const role of ROLES) {
      const context = await browser.newContext({ baseURL: config.baseUrl, viewport });
      opened.push(context);
      const page = await context.newPage();
      await signInCollaborationIdentity(page, config, users[role]);
      actors[role] = {
        userId: users[role].id,
        context,
        page,
        direct: createCollaborationDirectHarness({ page, userId: users[role].id, platformBaseUrl: config.baseUrl }),
        preconditions: await loadPreconditions(context, config),
      };
    }
    assertCollaborationPreconditions(config, {
      owner: actors.owner.preconditions,
      member: actors.member.preconditions,
      outsider: actors.outsider.preconditions,
      guest: actors.guest.preconditions,
    });
    let extra: CollaborationJourneyActor | undefined;
    if (multiComputerMember) {
      const context = await browser.newContext({ baseURL: config.baseUrl, viewport });
      opened.push(context);
      const page = await context.newPage();
      await signInCollaborationIdentity(page, config, multiComputerMember);
      const preconditions = await loadPreconditions(context, config);
      assertMultiComputerMemberPreconditions(config, preconditions);
      extra = { userId: multiComputerMember.id, context, page, preconditions, direct: createCollaborationDirectHarness({ page, userId: multiComputerMember.id, platformBaseUrl: config.baseUrl }) };
    }
    return {
      config,
      actors,
      ...(extra ? { multiComputerMember: extra } : {}),
      previewUrl: new URL(`/vm/${config.previewHandle}`, config.baseUrl).toString(),
      async close() {
        for (const actor of Object.values(actors)) actor.direct.direct.close();
        extra?.direct.direct.close();
        await Promise.allSettled(opened.map((context) => context.close()));
      },
    };
  } catch (error: unknown) {
    await Promise.allSettled(opened.map((context) => context.close()));
    throw error;
  }
}

export const collaborationTest = base.extend<{ collaborationJourney: FourAccountCollaborationJourney }>({
  collaborationJourney: async ({ browser, viewport }, use) => {
    const journey = await createFourAccountCollaborationJourney(browser, process.env, viewport ?? undefined);
    try { await use(journey); }
    finally { await journey.close(); }
  },
});

export { expect } from "@playwright/test";
