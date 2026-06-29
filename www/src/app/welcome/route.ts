import { auth, clerkClient } from "@clerk/nextjs/server";
import { parsePlanUrlSlug } from "../../lib/billing-plans";
import { getMarketingAuthRedirectUrl } from "../../inngest/provision-status";

// Persists a marketing-chosen plan to Clerk public metadata, then hands off to
// the app root. The onboarding state machine (deriveJourneyPhase) decides the
// phase from there — this route only records UI intent and never advances it.
export async function GET(req: Request): Promise<Response> {
  const appUrl = getMarketingAuthRedirectUrl();
  const planSlug = parsePlanUrlSlug(new URL(req.url).searchParams.get("plan"));

  if (planSlug) {
    try {
      const { userId } = await auth();
      if (userId) {
        const client = await clerkClient();
        await client.users.updateUserMetadata(userId, {
          publicMetadata: { selectedPlan: planSlug },
        });
      }
    } catch (err: unknown) {
      // Never block onboarding on a metadata write; the picker still has a
      // sensible default. Log a name only — no provider/PII leak.
      console.error(
        "[welcome] selectedPlan metadata write failed:",
        err instanceof Error ? err.name : typeof err,
      );
    }
  }

  return new Response(null, { status: 307, headers: { location: appUrl } });
}
