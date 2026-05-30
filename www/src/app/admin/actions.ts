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

// react-doctor-disable-next-line react-doctor/server-auth-actions -- authorized via requireAdmin() (currentUser + admin-role check) on the first line
export async function fetchContainers() {
  await requireAdmin();
  try {
    const res = await fetch(`${PLATFORM_API_URL}/containers`, {
      cache: "no-store",
      headers: authHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    return await res.json();
  } catch (err: unknown) {
    console.error(
      "[admin] fetchContainers request failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

// react-doctor-disable-next-line react-doctor/server-auth-actions -- authorized via requireAdmin() (currentUser + admin-role check) on the first line
export async function containerAction(method: string, path: string) {
  await requireAdmin();
  try {
    const res = await fetch(`${PLATFORM_API_URL}${path}`, {
      method,
      headers: authHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    return { ok: res.ok, status: res.status };
  } catch (err: unknown) {
    console.error(
      "[admin] containerAction request failed:",
      err instanceof Error ? err.message : err,
    );
    return { ok: false, status: 500 };
  }
}
