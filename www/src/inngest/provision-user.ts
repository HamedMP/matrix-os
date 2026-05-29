import { inngest } from "./client";
import { getPostHogClient, shutdownPostHog } from "@/lib/posthog-server";
import { MATRIX_TELEMETRY_EVENTS } from "@matrix-os/observability";
import {
  getProvisionVerificationTarget,
  isCustomerVpsUsableStatus,
  type ProvisionResult,
} from "./provision-status";

const PLATFORM_API_URL = process.env.PLATFORM_API_URL ?? "https://api.matrix-os.com";
const PLATFORM_SECRET = process.env.PLATFORM_SECRET ?? "";
const HANDLE_PREFIX = process.env.HANDLE_PREFIX ?? "";

export const provisionUser = inngest.createFunction(
  { id: "provision-matrix-os" },
  { event: "clerk/user.created" },
  async ({ event, step }) => {
    const user = event.data;
    const handle = `${HANDLE_PREFIX}${user.username ?? user.id}`;

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
          email: user.email_addresses?.[0]?.email_address,
          created_via: "clerk_signup",
        },
      });
    });

    await step.run("record-provision-started", async () => {
      const posthog = getPostHogClient();
      posthog.capture({
        distinctId: user.id,
        event: "inngest_provision_started",
        properties: {
          handle,
          source: "inngest",
        },
      });
    });

    const provisionResult = await step.run("provision-container", async (): Promise<ProvisionResult> => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (PLATFORM_SECRET) headers["authorization"] = `Bearer ${PLATFORM_SECRET}`;

      const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ") || handle;
      const res = await fetch(`${PLATFORM_API_URL}/containers/provision`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ handle, clerkUserId: user.id, displayName }),
      });

      if (res.status === 409) {
        return { alreadyProvisioned: true };
      }

      if (!res.ok) {
        const body = await res.text();
        const posthog = getPostHogClient();
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
      const posthog = getPostHogClient();
      const headers: Record<string, string> = {};
      if (PLATFORM_SECRET) headers["authorization"] = `Bearer ${PLATFORM_SECRET}`;
      const target = getProvisionVerificationTarget(PLATFORM_API_URL, handle, provisionResult);

      if (target.runtime === "customer_vps") {
        const res = await fetch(target.statusUrl, {
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error("VPS status not found after provision");
        const info = await res.json();

        if (!isCustomerVpsUsableStatus(info.status)) {
          throw new Error(`VPS not usable: ${info.status}`);
        }

        const eventName = info.status === "running"
          ? "inngest_provision_completed"
          : "inngest_provision_booting";

        posthog.capture({
          distinctId: user.id,
          event: eventName,
          properties: {
            handle,
            machine_status: info.status,
            runtime: "customer_vps",
            source: "inngest",
          },
        });

        posthog.identify({
          distinctId: user.id,
          properties: {
            has_instance: true,
            instance_runtime: "customer_vps",
            instance_status: info.status,
          },
        });

        await shutdownPostHog();
        return { status: info.status, runtime: "customer_vps" };
      }

      const res = await fetch(target.containerUrl, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error("Container not found after provision");
      const info = await res.json();

      if (info.status !== "running") {
        throw new Error(`Container not running: ${info.status}`);
      }

      const healthUrl = `http://localhost:${info.port}/health`;
      try {
        const healthRes = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
        if (!healthRes.ok) throw new Error(`Gateway health check failed: ${healthRes.status}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "unknown error";
        throw new Error(`Gateway not reachable at port ${info.port}: ${message}`);
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
