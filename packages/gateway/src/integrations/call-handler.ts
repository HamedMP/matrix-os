import type { Context } from "hono";
import { z } from "zod/v4";
import { admitGoogleCollection, type GoogleCollectionAdmission } from "./collection-hook.js";
import { executeIntegrationAction } from "./action-execution.js";
import { integrationActionFailure, integrationActionSuccess } from "./call-outcome.js";
import { formatActionParamValidationError, validateActionParams } from "./parameter-validation.js";
import { AMBIGUOUS_CONNECTION_ERROR, resolveIntegrationConnection, resolveManagedIntegrationCall } from "./connection-selection.js";
import { getAction, getService, getServiceByPipedreamApp } from "./registry.js";
import type { IntegrationBroadcast, IntegrationRoutesOpts } from "./routes.js";
import type { PipedreamConnectClient } from "./pipedream.js";

const CallBodySchema = z.object({
  service: z.string().min(1),
  action: z.string().min(1),
  label: z.string().trim().min(1).max(100).optional(),
  connectionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export interface IntegrationCallHandlerDependencies extends Pick<IntegrationRoutesOpts, "db" | "pipedream" | "mcpPresetBroker"> {
  googleCollection?: GoogleCollectionAdmission;
  requireUser(c: Context): Promise<string | null>;
  getOrCreateExternalId(uid: string): Promise<string>;
  consumePendingLabel(key: string): string | undefined;
  applyExplicitReconnectLabel(row: { id: string; inserted: boolean }, explicitLabel: string | undefined): Promise<void>;
  resolveAccountEmail(pipedream: PipedreamConnectClient, externalUserId: string, accountId: string, service: string): Promise<string | undefined>;
  emit: IntegrationBroadcast;
}
/** General call orchestration, extracted without changing preset/account-sync behavior. */
export function createIntegrationCallHandler(deps: IntegrationCallHandlerDependencies) {
  const { db, pipedream, requireUser, mcpPresetBroker, getOrCreateExternalId, consumePendingLabel, applyExplicitReconnectLabel, resolveAccountEmail, emit } = deps;
  return async (c: Context): Promise<Response> => {
    const uid = await requireUser(c);
    if (!uid) return c.json({ error: "Unauthorized" }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err: unknown) {
      console.warn("[integrations] Invalid call JSON:", err instanceof Error ? err.message : String(err));
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const parsed = CallBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
    }

    const { service, action, label, params, connectionId } = parsed.data;

    const def = getService(service);
    if (!def) {
      return c.json({ error: `Unknown service: ${service}` }, 400);
    }

    const actionDef = getAction(service, action);
    if (!actionDef) {
      return c.json({ error: `Unknown action: ${action} for service ${service}` }, 400);
    }

    // Validate action params against the registry definition
    const paramValidation = validateActionParams(actionDef, params);
    if (!paramValidation.valid) {
      return c.json({
        error: formatActionParamValidationError(paramValidation),
        missing: paramValidation.missing.length > 0 ? paramValidation.missing : undefined,
        type_errors: paramValidation.typeErrors.length > 0 ? paramValidation.typeErrors : undefined,
        value_errors: paramValidation.valueErrors?.length ? paramValidation.valueErrors : undefined,
      }, 400);
    }

    if (def.connectorKind === "mcp_preset" || def.connectorKind === "managed_oauth") {
      if (!mcpPresetBroker) return c.json({ error: "Integration service unavailable" }, 503);
      try {
        const selected = await resolveManagedIntegrationCall({ service, label, connectionId,
          listConnections: () => mcpPresetBroker.listConnections(uid) });
        if (selected.kind === "ambiguous") return c.json({ error: AMBIGUOUS_CONNECTION_ERROR }, 409);
        if (selected.kind === "denied") return c.json({ error: "Action not permitted" }, 403);
        const data = await mcpPresetBroker.call({
          userId: uid,
          service: def,
          actionId: action,
          params,
          ...(selected.kind === "found" ? { connectionId: selected.connectionId } : {}),
        });
        return c.json({ data, service, action });
      } catch (err) {
        if (err && typeof err === "object" && "code" in err
          && err.code === "unsupported_granola_parameter"
          && "parameter" in err
          && ["folderId", "timeRange", "limit"].includes(String(err.parameter))) {
          const parameter = String(err.parameter);
          return c.json({
            error: `Parameter ${parameter} is not supported by this connection`,
            code: "unsupported_parameter",
            parameter,
          }, 400);
        }
        console.error("[integrations] MCP preset call failed:", err instanceof Error ? err.message : String(err));
        return c.json({ error: "Integration call failed" }, 502);
      }
    }

    // Find the user's active connection for this service. On cache miss
    // (no row in local DB), pull the authoritative list from Pipedream and
    // upsert any new accounts -- this fixes the "just connected via chat, no
    // webhook available in local dev" flow where the OAuth completes at
    // Pipedream but the webhook never reaches the gateway. Without this
    // retry, the agent saw "not connected" forever and looped on new connect
    // links.
    const connections = await db.listConnectedServices(uid);
    let selection = resolveIntegrationConnection(connections, service, label);
    if (selection.kind === "ambiguous") return c.json({ error: AMBIGUOUS_CONNECTION_ERROR }, 409);
    let connection = selection.kind === "found" ? selection.connection : undefined;
    // A bot's saved grant names a specific row. Never sync/reselect a missing
    // row, because the same label may now belong to a different account.
    if (connectionId && connection?.id !== connectionId) return c.json({ error: "Action not permitted" }, 403);

    if (!connection) {
      try {
        const extId = await getOrCreateExternalId(uid);
        const pdAccounts = await pipedream.listAccounts(extId);
        const existingPdIds = new Set(connections.map((s) => s.pipedream_account_id));
        const newAccounts = pdAccounts.flatMap(acc => {
          const matchedService = getServiceByPipedreamApp(acc.app);
          return !existingPdIds.has(acc.id) && matchedService ? [{ ...acc, serviceId: matchedService.id }] : [];
        });
        if (newAccounts.length > 0) {
          await Promise.all(
            newAccounts.map(async (acc) => {
              const pendingKey = `${extId}:${acc.app}`;
              const explicitLabel = consumePendingLabel(pendingKey);
              const lbl = explicitLabel ?? acc.serviceId;
              // Do not fetch Gmail profile data before canonical account admission.
              const resolvedEmail = acc.email
                ?? (acc.serviceId === "gmail" && deps.googleCollection ? undefined : await resolveAccountEmail(pipedream, extId, acc.id, acc.serviceId));
              const row = await db.connectService({
                userId: uid,
                service: acc.serviceId,
                pipedreamAccountId: acc.id,
                accountLabel: lbl,
                accountEmail: resolvedEmail,
                scopes: [],
              });
              await applyExplicitReconnectLabel(row, explicitLabel);
              if (row.inserted) {
                emit({ type: "integration:connected", service: row.service, accountLabel: lbl });
              }
            }),
          );
          // Re-read after the upserts and retry the lookup.
          const refreshed = await db.listConnectedServices(uid);
          selection = resolveIntegrationConnection(refreshed, service, label);
          if (selection.kind === "ambiguous") return c.json({ error: AMBIGUOUS_CONNECTION_ERROR }, 409);
          connection = selection.kind === "found" ? selection.connection : undefined;
        }
      } catch (err) {
        // Sync-on-miss is best-effort. If Pipedream is down or the listAccounts
        // call fails, fall through to the normal "not connected" response
        // instead of 500'ing the request. The error is logged for debugging.
        console.warn(
          `[integrations] sync-on-miss failed for ${service}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (!connection) {
      if (label) {
        const available = connections
          .filter((s) => s.service === service)
          .map((s) => s.account_label);
        return c.json({
          error: `No ${service} account with label "${label}"`,
          available_labels: available.length > 0 ? available : undefined,
          connect_hint: available.length === 0
            ? `Use POST /api/integrations/connect with { "service": "${service}" } to connect it first.`
            : undefined,
        }, available.length > 0 ? 400 : 404);
      }
      return c.json({
        error: `Service ${service} is not connected`,
        connect_hint: `Use POST /api/integrations/connect with { "service": "${service}" } to connect it first.`,
      }, 404);
    }

    const externalId = await getOrCreateExternalId(uid);
    let lease: Awaited<ReturnType<typeof admitGoogleCollection>>;

    try {
      lease = await admitGoogleCollection(deps.googleCollection, c, uid, connection, "/call");
      const { data, summary } = await executeIntegrationAction({
        pipedream,
        externalUserId: externalId,
        connection,
        def,
        actionDef,
        serviceId: service,
        actionId: action,
        params,
        beforeSend: lease?.beforeSend,
        signal: c.req.raw.signal,
      });

      return await integrationActionSuccess(c, { db, connectionId: connection.id, service, action, data, summary, beforeRelease: lease?.release });
    } catch (err: unknown) {
      try { await lease?.release(); } catch (releaseError) { return integrationActionFailure(c, releaseError, service, action); }
      return integrationActionFailure(c, err, service, action);
    }
  };
}
