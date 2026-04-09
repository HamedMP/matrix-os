"use server";

import { currentUser } from "@clerk/nextjs/server";

const PLATFORM_API_URL = process.env.PLATFORM_API_URL ?? "https://api.matrix-os.com";
const PLATFORM_SECRET = process.env.PLATFORM_SECRET ?? "";

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (PLATFORM_SECRET) {
    headers["authorization"] = `Bearer ${PLATFORM_SECRET}`;
  }
  return headers;
}

async function requireAdmin() {
  const user = await currentUser();
  if (!user) throw new Error("Not authenticated");
  const metadata = user.publicMetadata as Record<string, unknown>;
  if (metadata?.role !== "admin") throw new Error("Not authorized");
}

export async function fetchContainers() {
  await requireAdmin();
  try {
    const res = await fetch(`${PLATFORM_API_URL}/containers`, {
      cache: "no-store",
      headers: authHeaders(),
    });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export async function containerAction(method: string, path: string) {
  await requireAdmin();
  try {
    const res = await fetch(`${PLATFORM_API_URL}${path}`, {
      method,
      headers: authHeaders(),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 500 };
  }
}
