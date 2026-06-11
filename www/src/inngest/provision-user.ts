import { NonRetriableError } from "inngest";
import { inngest } from "./client";
import { getPostHogClient, shutdownPostHog } from "@/lib/posthog-server";
import { MATRIX_TELEMETRY_EVENTS } from "@matrix-os/observability";
import { getPrimaryEmail, getProvisionHandleCandidates } from "./provision-user-handle";

const PLATFORM_API_URL = process.env.PLATFORM_API_URL ?? "https://api.matrix-os.com";
const PLATFORM_SECRET = process.env.PLATFORM_SECRET ?? "";
const HANDLE_PREFIX = process.env.HANDLE_PREFIX ?? "";

export const provisionUser = inngest.createFunction(
  { id: "provision-matrix-os" },
  { event: "clerk/user.created" },
  async ({ event, step }) => {
    const user = event.data;
    const handleCandidates = getProvisionHandleCandidates(user, HANDLE_PREFIX);
    const handle = handleCandidates[0];
    if (!handle) {
      throw new NonRetriableError("Unable to derive a valid Matrix OS handle");
    }
    const email = getPrimaryEmail(user);

    await step.run("record-signup", async () => {
      const posthog = getPostHogClient();
      posthog.capture({
        distinctId: user.id,
        event: MATRIX_TELEMETRY_EVENTS.USER_SIGNED_UP,
        properties: {
          handle,
          source: "clerk_signup",
        },
      });

      posthog.identify({
        distinctId: user.id,
        properties: {
          handle,
          email,
          created_via: "clerk_signup",
        },
      });

      // Customer VPS gateways may only know the handle (MATRIX_HANDLE); the
      // alias merges handle-keyed server events into the Clerk person.
      posthog.alias({
        distinctId: user.id,
        alias: handle,
      });
    });

    await step.run("sync-platform-user", async () => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (PLATFORM_SECRET) headers["authorization"] = `Bearer ${PLATFORM_SECRET}`;

      for (const candidateHandle of handleCandidates) {
        const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ") || candidateHandle;
        const res = await fetch(`${PLATFORM_API_URL}/users/sync`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({ handle: candidateHandle, clerkUserId: user.id, displayName, email }),
        });

        if (res.status === 409) {
          continue;
        }

        if (!res.ok) {
          const body = await res.text();
          const posthog = getPostHogClient();
          posthog.capture({
            distinctId: user.id,
            event: "inngest_user_sync_failed",
            properties: {
              handle: candidateHandle,
              error: body,
              status: res.status,
              source: "inngest",
            },
          });
          await shutdownPostHog();
          throw new Error(`User sync failed: ${res.status} ${body}`);
        }

        const posthog = getPostHogClient();
        posthog.capture({
          distinctId: user.id,
          event: "inngest_user_synced",
          properties: {
            handle: candidateHandle,
            source: "inngest",
          },
        });

        posthog.identify({
          distinctId: user.id,
          properties: {
            handle: candidateHandle,
            email,
            has_instance: false,
            billing_required: true,
          },
        });

        await shutdownPostHog();
        return;
      }

      const posthog = getPostHogClient();
      posthog.capture({
        distinctId: user.id,
        event: "inngest_user_sync_failed",
        properties: {
          handle,
          status: 409,
          source: "inngest",
        },
      });
      await shutdownPostHog();
      throw new NonRetriableError("User sync failed: no available Matrix OS handle");
    });
  },
);
