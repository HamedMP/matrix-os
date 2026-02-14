"use server";

import { currentUser } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";

const PLATFORM_API_URL = process.env.PLATFORM_API_URL ?? "https://api.matrix-os.com";

export async function provisionInstance(): Promise<{ error?: string }> {
  const user = await currentUser();
  if (!user) return { error: "Not authenticated" };

  const handle = user.username ?? user.id;

  const res = await fetch(`${PLATFORM_API_URL}/containers/provision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle, clerkUserId: user.id }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return { error: data.error ?? "Provisioning failed" };
  }

  revalidatePath("/dashboard");
  return {};
}
