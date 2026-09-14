/**
 * Live development-project gate for spec 118.
 *
 * PIPEDREAM_VERIFICATION_CASES is a JSON object keyed by Matrix service id:
 * {"posthog":{"accountId":"apn_...","action":"list_projects","componentKey":"posthog-list-projects"}}
 * The script intentionally requires real connected accounts and invokes the
 * production execution boundary; it never fabricates component keys.
 */
import { createPipedreamClient } from "../packages/gateway/src/integrations/pipedream.js";
import { executeIntegrationAction } from "../packages/gateway/src/integrations/routes.js";
import { getAction, getService } from "../packages/gateway/src/integrations/registry.js";
import { bindDiscoveredComponentKey } from "./lib/pipedream-integration-verification.js";

const REQUIRED = ["google_docs", "notion", "figma", "posthog", "jira", "stripe"] as const;
const clientId = process.env.PIPEDREAM_CLIENT_ID;
const clientSecret = process.env.PIPEDREAM_CLIENT_SECRET;
const projectId = process.env.PIPEDREAM_PROJECT_ID;
const externalUserId = process.env.PIPEDREAM_VERIFICATION_EXTERNAL_USER_ID;
const casesRaw = process.env.PIPEDREAM_VERIFICATION_CASES;

if (!clientId || !clientSecret || !projectId || !externalUserId || !casesRaw) {
  throw new Error("Live verification requires Pipedream development credentials, an external user id, and PIPEDREAM_VERIFICATION_CASES");
}
if ((process.env.PIPEDREAM_ENVIRONMENT ?? "development") !== "development") {
  throw new Error("Verification is development-environment only");
}

const cases = JSON.parse(casesRaw) as Record<string, {
  accountId: string;
  action: string;
  componentKey?: string;
  params?: Record<string, unknown>;
}>;
const pipedream = await createPipedreamClient({
  clientId,
  clientSecret,
  projectId,
  environment: "development",
});

for (const serviceId of REQUIRED) {
  const service = getService(serviceId);
  const verification = cases[serviceId];
  if (!service?.pipedreamApp || !verification) throw new Error(`Missing verification case for ${serviceId}`);
  const app = await pipedream.getAppInfo(service.pipedreamApp);
  if (!app) throw new Error(`Pipedream app slug not found: ${service.pipedreamApp}`);
  const discovered = await pipedream.discoverActions(service.pipedreamApp);
  const action = getAction(serviceId, verification.action);
  if (!action || action.risk !== "read") throw new Error(`${serviceId} verification action must be read-only`);
  const verifiedAction = bindDiscoveredComponentKey({
    serviceId,
    actionId: verification.action,
    action,
    discovered,
    componentKey: verification.componentKey,
  });
  const result = await executeIntegrationAction({
    pipedream,
    externalUserId,
    connection: { pipedream_account_id: verification.accountId },
    def: service,
    actionDef: verifiedAction,
    serviceId,
    actionId: verification.action,
    params: verification.params,
  });
  process.stdout.write(`${JSON.stringify({
    service: serviceId,
    appSlug: service.pipedreamApp,
    appName: app.name,
    discoveredComponentKeys: discovered.map((item) => item.key),
    verifiedComponentKey: verifiedAction.componentKey ?? null,
    readAction: verification.action,
    readSucceeded: result.data !== undefined,
  })}\n`);
}
