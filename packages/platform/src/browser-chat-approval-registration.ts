import type { Hono } from "hono";
import { createBrowserChatApprovalRoutes } from "./browser-chat-approval-routes.js";
import { BrowserApprovalMachineLookup } from "./browser-approval-machine-lookup.js";
/** Separate from integration routes: preview verification still requires the
 * new exact owner proof and never gains integration authority. Default off.
 */
export function registerBrowserChatApprovalRoutes(app: Hono<any>, options: { platformSecret: string; env: NodeJS.ProcessEnv; lookup?: BrowserApprovalMachineLookup }) {
  const enabled = options.env.MATRIX_SUPERVISED_BROWSER_APPROVALS_ENABLED === "true";
  const owned = enabled && !options.lookup && options.env.PLATFORM_DATABASE_URL
    ? new BrowserApprovalMachineLookup({ databaseUrl: options.env.PLATFORM_DATABASE_URL }) : undefined;
  app.route("/", createBrowserChatApprovalRoutes({ enabled, platformSecret: options.platformSecret, lookup: options.lookup ?? owned }));
  // Injection remains caller-owned; only this factory closes its own resource.
  return () => owned?.close() ?? Promise.resolve();
}
