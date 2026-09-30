import { connection } from "next/server";

/**
 * Server-only. The platform starts its auth shell with
 * `MATRIX_SHELL_SURFACE=platform` (scripts/start-platform-cloud-run.sh);
 * customer computers never set it. It is process environment rather than a
 * request header, so no client can select the account-only frame on a
 * computer or the full OS on the platform. `connection()` keeps the read at
 * request time so a build-time prerender never bakes in the build host's value.
 */
export async function isPlatformShellSurface(): Promise<boolean> {
  await connection();
  return process.env.MATRIX_SHELL_SURFACE === "platform";
}
