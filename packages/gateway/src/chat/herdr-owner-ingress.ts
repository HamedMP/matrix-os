import type { Context } from "hono";
import { PREVIEW_TERMINAL_OWNER_CONTEXT_KEY } from "../preview-terminal-access.js";
import { hasVerifiedRuntimeBearer, type RequestPrincipal } from "../request-principal.js";
import { MATRIX_MCP_RUN_CONTEXT_KEY } from "./matrix-mcp-launch.js";

/** Self-host nginx supplies its gateway bearer after checking the tailnet owner or Basic Auth. */
export function hasDirectHerdrOwner(context: Context, principal: RequestPrincipal): boolean {
  if (context.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
    || context.req.query("token") !== undefined
    || context.get(MATRIX_MCP_RUN_CONTEXT_KEY as never) || context.get(PREVIEW_TERMINAL_OWNER_CONTEXT_KEY as never)
    || process.env.MATRIX_PREVIEW_RUNTIME === "true") return false;
  if (principal.source === "jwt" || principal.source === "platform-verified") return true;
  if (principal.source !== "configured-container" || process.env.MATRIX_SELF_HOSTED !== "1"
    || !process.env.MATRIX_USER_ID || principal.userId !== process.env.MATRIX_USER_ID
    || !hasVerifiedRuntimeBearer(context)) return false;

  // Browser requests carrying ambient ingress credentials must come from the same origin.
  // Electron's native transport can omit both headers. Browsers set Sec-Fetch-Site themselves.
  const site = context.req.header("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = context.req.header("origin");
  // Plain HTTP Headscale may omit fetch metadata. Compare with the installer-owned origin.
  return !origin || origin === process.env.MATRIX_TAILNET_URL;
}
