import { createRoutineOriginVerificationRoutes } from "./routine-origin-proof-routes.js";
import { createRoutineActionVerificationRoutes } from "./routine-action-routes.js";
import { createRoutineFullAccessVerificationRoutes } from "./routine-full-access-routes.js";
import type { Hono } from "hono";
import { createBrowserChatApprovalRoutes } from "./browser-chat-approval-routes.js";
import { BrowserApprovalMachineLookup } from "./browser-approval-machine-lookup.js";
import { resolveBrowserApprovalPolicy } from "./browser-dev-approval-policy.js";
/** Separate from integration routes: preview verification still requires the
 * new exact owner proof and never gains integration authority. Default off.
 */
export function registerBrowserChatApprovalRoutes(app: Hono<any>, options: { platformSecret: string; env: NodeJS.ProcessEnv; lookup?: BrowserApprovalMachineLookup }) {
  const policy = resolveBrowserApprovalPolicy(options.env);
  const owned = !options.lookup && options.env.PLATFORM_DATABASE_URL
    ? new BrowserApprovalMachineLookup({ databaseUrl: options.env.PLATFORM_DATABASE_URL }) : undefined;
  const lookup = options.lookup ?? owned;
  app.route("/", createBrowserChatApprovalRoutes({ enabled: policy.kind !== "disabled", platformSecret: options.platformSecret,
    lookup, devScope: policy.kind === "scoped" ? policy.scope : undefined }));
  app.route("/", createRoutineActionVerificationRoutes({ platformSecret: options.platformSecret, lookup }));
  app.route("/", createRoutineFullAccessVerificationRoutes({ platformSecret: options.platformSecret, lookup }));
  app.route("/", createRoutineOriginVerificationRoutes({ platformSecret: options.platformSecret, lookup }));
  // Injection remains caller-owned; only this factory closes its own resource.
  return { policy, lookup, close: () => owned?.close() ?? Promise.resolve() };
}
