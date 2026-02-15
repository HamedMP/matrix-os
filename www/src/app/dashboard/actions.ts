"use server";

import { currentUser } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { getPostHogClient } from "@/lib/posthog-server";

const PLATFORM_API_URL = process.env.PLATFORM_API_URL ?? "https://api.matrix-os.com";

export async function provisionInstance(): Promise<{ error?: string }> {
  const user = await currentUser();
  if (!user) return { error: "Not authenticated" };

  const handle = user.username ?? user.id;
  const posthog = getPostHogClient();

  const res = await fetch(`${PLATFORM_API_URL}/containers/provision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle, clerkUserId: user.id }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    posthog.capture({
      distinctId: user.id,
      event: "provision_failed",
      properties: {
        handle,
        error: data.error ?? "Provisioning failed",
        source: "server_action",
      },
    });
    return { error: data.error ?? "Provisioning failed" };
  }

  posthog.capture({
    distinctId: user.id,
    event: "provision_completed",
    properties: {
      handle,
      source: "server_action",
    },
  });

  posthog.identify({
    distinctId: user.id,
    properties: {
      handle,
      email: user.emailAddresses?.[0]?.emailAddress,
      has_instance: true,
    },
  });

  revalidatePath("/dashboard");
  return {};
}
