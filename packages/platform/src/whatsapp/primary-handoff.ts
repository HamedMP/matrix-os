import { CanonicalChatIdSchema } from "@matrix-os/contracts";
import type { Context } from "hono";
import { getRunningUserMachineByClerkId, type PlatformDB } from "../db.js";
import { HANDLE_PATTERN } from "../platform-route-utils.js";

/** Navigation selects an explicit owner-authorized computer; it never changes
 * the authority of the signed session used by ordinary gateway requests. */
export async function whatsappPrimaryHandoffResponse(c: Context, deps: {
  db: PlatformDB;
  /** Only supplied after the existing identity resolver verifies the owner. */
  verifiedOwner: string | undefined;
}): Promise<Response | null> {
  const url = new URL(c.req.url);
  const params = url.searchParams;
  if (c.req.method !== "GET" || url.pathname !== "/" || !params.has("chat")
    || params.get("launch") !== "__chat__" || params.get("runtime") !== "primary") return null;

  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  const keys = ["chat", "launch", "runtime"];
  const chat = CanonicalChatIdSchema.safeParse(params.get("chat"));
  if (params.toString().length > 512 || !chat.success
    || [...params.keys()].some((key) => !keys.includes(key))
    || keys.some((key) => params.getAll(key).length !== 1)) {
    return c.text("This link is invalid. Open Matrix to continue.", 400);
  }
  if (!deps.verifiedOwner) return c.text("Unauthorized", 401);
  const machine = await getRunningUserMachineByClerkId(deps.db, deps.verifiedOwner, "primary");
  if (!machine || machine.clerkUserId !== deps.verifiedOwner || machine.runtimeSlot !== "primary"
    || machine.provisioningClass !== "customer" || !HANDLE_PATTERN.test(machine.handle)) {
    return c.text("Matrix OS computer unavailable", 404);
  }
  const query = new URLSearchParams({ chat: chat.data, launch: "__chat__", runtime: "primary" });
  // The normal explicit-VM route rechecks ownership and runtime entitlement.
  return c.redirect(`/vm/${machine.handle}?${query}`, 302);
}
