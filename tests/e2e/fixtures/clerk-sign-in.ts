import { clerk } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";
import {
  verifyClerkFixtureUser,
  type CollaborationIdentityEnvironment,
  type VerifiedFixtureUser,
} from "./collaboration-identities.js";

/** Recheck both guards immediately before Clerk's helper mints a sign-in token. */
export async function signInCollaborationIdentity(
  page: Page,
  config: CollaborationIdentityEnvironment,
  user: VerifiedFixtureUser,
): Promise<void> {
  const verified = await verifyClerkFixtureUser(config, user.id);
  if (verified.emailAddress !== user.emailAddress) throw new Error("Collaboration test identity changed during setup");
  await page.goto(`${config.baseUrl}/sign-in`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await clerk.loaded({ page });
  await clerk.signIn({ page, emailAddress: verified.emailAddress });
  const activeUserId = await page.evaluate(() => window.Clerk.user?.id ?? null);
  if (activeUserId !== verified.id) throw new Error("Collaboration sign-in resolved to a different identity");
}

/** This credential stays in memory and is never passed to Playwright trace or storageState. */
export async function collaborationSessionToken(page: Page, expectedUserId: string): Promise<string> {
  const token = await page.evaluate(async (userId) => {
    if (window.Clerk.user?.id !== userId) return null;
    return await window.Clerk.session?.getToken() ?? null;
  }, expectedUserId);
  if (!token || token.length > 8_192) throw new Error("Collaboration session is unavailable");
  return token;
}
