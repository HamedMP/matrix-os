import { readBoundedRepairJson, submitAppRepairChat, type AppRepairContext, type AppRepairRequest } from "@matrix-os/contracts";
import { getGatewayUrl } from "./gateway";

export const requestShellRepair: AppRepairRequest = async (path, init) => {
  const response = await fetch(`${getGatewayUrl()}${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body,
    signal: AbortSignal.timeout(12_000),
    redirect: "error",
  });
  return readBoundedRepairJson(response);
};

export function openShellRepairChat(context: AppRepairContext): Promise<{ chatId: string }> {
  return submitAppRepairChat(requestShellRepair, context);
}
