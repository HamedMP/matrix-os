import { describe, expect, it, vi } from "vitest";
import { getService } from "../../packages/gateway/src/integrations/registry.js";
import { TASK_CRM_WRITE_ACTIONS } from "../../packages/gateway/src/integrations/task-crm-writes.js";
import { DOCUMENT_WRITE_ACTIONS } from "../../packages/gateway/src/integrations/document-writes.js";
import { MICROSOFT_WRITE_ACTIONS } from "../../packages/gateway/src/integrations/microsoft-writes.js";
import { FILE_COMMUNICATION_WRITE_ACTIONS } from "../../packages/gateway/src/integrations/file-communication-writes.js";
import { FINANCE_WRITE_ACTIONS } from "../../packages/gateway/src/integrations/finance-writes.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

describe("managed write action wiring", () => {
  for (const map of [TASK_CRM_WRITE_ACTIONS, DOCUMENT_WRITE_ACTIONS, MICROSOFT_WRITE_ACTIONS, FILE_COMMUNICATION_WRITE_ACTIONS, FINANCE_WRITE_ACTIONS]) {
    for (const [serviceId, actions] of Object.entries(map)) {
      it(`publishes reviewed ${serviceId} actions with their validation and approval policy`, () => {
        for (const [id, action] of Object.entries(actions)) {
          expect(getService(serviceId)?.actions[id], `${serviceId}/${id}`).toBe(action);
          expect(action.risk).toBe("write");
          expect(action.paramsSchema).toBeDefined();
        }
      });
    }
  }
  it("dispatches Stripe writes through the bound finance seam before generic reads or proxy", async () => {
    const boundedFinanceAction = vi.fn().mockResolvedValue({ id: "cus_123" });
    const proxy = vi.fn(); const runAction = vi.fn();
    const def = getService("stripe")!;
    const result = await executeIntegrationAction({ pipedream: { boundedFinanceAction, proxy, runAction } as unknown as PipedreamConnectClient,
      externalUserId: "owner", connection: { pipedream_account_id: "account" }, def,
      actionDef: FINANCE_WRITE_ACTIONS.stripe.create_customer, serviceId: "stripe", actionId: "create_customer", params: { name: "Alex" } });
    expect(result).toEqual({ data: { id: "cus_123" } });
    expect(boundedFinanceAction).toHaveBeenCalledWith({ externalUserId: "owner", accountId: "account", serviceId: "stripe", actionId: "create_customer", params: { name: "Alex" } });
    expect(proxy).not.toHaveBeenCalled(); expect(runAction).not.toHaveBeenCalled();
  });
});
