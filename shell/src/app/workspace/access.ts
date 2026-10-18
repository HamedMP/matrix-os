import { timingSafeEqual } from "node:crypto";
import { auth } from "@clerk/nextjs/server";
import { starterPilotForOwner } from '@matrix-os/contracts/starter-computers';

/** Isolated automation only: both token and fixed owner mapping must exist. */
export function hasSharedPreviewBearer(headers: Headers): boolean {
  if (process.env.MATRIX_SHARED_WORKSPACE_SPIKE !== "1") return false;
  const token = process.env.MATRIX_SHARED_WORKSPACE_PREVIEW_TOKEN;
  const owner = process.env.MATRIX_SHARED_WORKSPACE_PREVIEW_OWNER_ID;
  const supplied = headers.get("authorization");
  if (!token || !owner || !supplied || token.length > 4096 || supplied.length > 4103) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function sharedWorkspaceAccess(headers: Headers): Promise<
  { status: 200; token: string; origin?: string } | { status: 401 | 404 | 503 }
> {
  if (process.env.MATRIX_SHARED_WORKSPACE_SPIKE !== "1") return { status: 404 };
  const pilotConfigured = process.env.MATRIX_STARTER_COMPUTERS !== undefined;
  if (!pilotConfigured && hasSharedPreviewBearer(headers)) return { status: 200, token: process.env.MATRIX_SHARED_WORKSPACE_PREVIEW_TOKEN! };
  const session = await auth();
  if (!session.userId) return { status: 401 };
  if (pilotConfigured) {
    try {
      const pilot = starterPilotForOwner(process.env.MATRIX_STARTER_COMPUTERS, session.userId);
      return pilot ? { status: 200, token: pilot.token, origin: pilot.origin } : { status: 404 };
    } catch (error: unknown) {
      console.warn('[workspace] Starter configuration unavailable', error instanceof Error ? error.name : 'UnknownError');
      return { status: 503 };
    }
  }
  const token = await session.getToken();
  return token ? { status: 200, token } : { status: 503 };
}

export function sharedWorkerTarget(path: string[], search: string, ownerOrigin?: string): URL {
  const configured = ownerOrigin ?? process.env.MATRIX_SHARED_WORKSPACE_ORIGIN;
  if (!configured) throw new Error("Shared workspace is unavailable");
  const origin = new URL(configured);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname);
  if ((origin.protocol !== "https:" && !(origin.protocol === "http:" && local))
    || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Shared workspace origin is invalid");
  }
  if (!path.length || path.length > 32 || search.length > 8192
    || path.some((segment) => !/^[A-Za-z0-9_.-]{1,256}$/.test(segment) || segment === "." || segment === "..")) {
    throw new Error("Shared workspace path is invalid");
  }
  const url = new URL(`/${path.join("/")}`, origin);
  url.search = search;
  return url;
}

/** Explicit deployment origin survives internal rewrites without trusting Host. */
export function sharedShellOrigin(requestUrl: string): string {
  const configured = process.env.MATRIX_SHARED_WORKSPACE_SHELL_ORIGIN;
  const url = new URL(configured ?? requestUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (configured && ((url.protocol !== "https:" && !(url.protocol === "http:" && local))
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash)) {
    throw new Error("Shared shell origin is invalid");
  }
  return url.origin;
}
