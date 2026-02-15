import { inngest } from "./client";
import { getPostHogClient, shutdownPostHog } from "@/lib/posthog-server";

const PLATFORM_API_URL = process.env.PLATFORM_API_URL ?? "https://api.matrix-os.com";
const PLATFORM_SECRET = process.env.PLATFORM_SECRET ?? "";

export const provisionUser = inngest.createFunction(
  { id: "provision-matrix-os" },
  { event: "clerk/user.created" },
  async ({ event, step }) => {
    const user = event.data;
    const handle = user.username ?? user.id;
    const posthog = getPostHogClient();

    posthog.capture({
      distinctId: user.id,
      event: "inngest_provision_started",
      properties: {
        handle,
        source: "inngest",
      },
    });

    posthog.identify({
      distinctId: user.id,
      properties: {
        handle,
        email: user.email_addresses?.[0]?.email_address,
        created_via: "clerk_signup",
      },
    });

    await step.run("provision-container", async () => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (PLATFORM_SECRET) headers["authorization"] = `Bearer ${PLATFORM_SECRET}`;

      const res = await fetch(`${PLATFORM_API_URL}/containers/provision`, {
        method: "POST",
        headers,
        body: JSON.stringify({ handle, clerkUserId: user.id }),
      });

      if (res.status === 409) {
        return { alreadyProvisioned: true };
      }

      if (!res.ok) {
        const body = await res.text();
        posthog.capture({
          distinctId: user.id,
          event: "inngest_provision_failed",
          properties: {
            handle,
            error: body,
            status: res.status,
            source: "inngest",
          },
        });
        throw new Error(`Provision failed: ${res.status} ${body}`);
      }

      return await res.json();
    });

    await step.sleep("wait-for-boot", "10s");

    await step.run("verify-running", async () => {
      const headers: Record<string, string> = {};
      if (PLATFORM_SECRET) headers["authorization"] = `Bearer ${PLATFORM_SECRET}`;

      const res = await fetch(`${PLATFORM_API_URL}/containers/${handle}`, { headers });
      if (!res.ok) throw new Error("Container not found after provision");
      const info = await res.json();

      if (info.status !== "running") {
        throw new Error(`Container not running: ${info.status}`);
      }

      const healthUrl = `http://localhost:${info.port}/health`;
      try {
        const healthRes = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
        if (!healthRes.ok) throw new Error(`Gateway health check failed: ${healthRes.status}`);
      } catch (e: any) {
        throw new Error(`Gateway not reachable at port ${info.port}: ${e.message}`);
      }

      posthog.capture({
        distinctId: user.id,
        event: "inngest_provision_completed",
        properties: {
          handle,
          container_status: info.status,
          source: "inngest",
        },
      });

      posthog.identify({
        distinctId: user.id,
        properties: {
          has_instance: true,
          instance_status: info.status,
        },
      });

      await shutdownPostHog();
      return { status: info.status };
    });
  },
);
