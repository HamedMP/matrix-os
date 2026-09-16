import { randomUUID } from "node:crypto";

export interface ApprovalRequest {
  type: "approval:request";
  id: string;
  toolName: string;
  args: unknown;
  timeout: number;
}

export interface ApprovalResponse {
  id: string;
  approved: boolean;
}

export interface ApprovalBridgeConfig {
  send: (msg: ApprovalRequest) => void;
  timeout: number;
}

export interface ApprovalBridge {
  requestApproval: (toolName: string, args: unknown) => Promise<boolean>;
  handleResponse: (response: ApprovalResponse) => void;
}

export function createApprovalBridge(config: ApprovalBridgeConfig): ApprovalBridge {
  const pending = new Map<string, { resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout> }>();

  return {
    requestApproval(toolName, args) {
      return new Promise<boolean>((resolve) => {
        const id = randomUUID();

        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            resolve(false);
          }
        }, config.timeout);

        pending.set(id, { resolve, timer });

        config.send({
          type: "approval:request",
          id,
          toolName,
          args,
          timeout: config.timeout,
        });
      });
    },

    handleResponse(response) {
      const entry = pending.get(response.id);
      if (!entry) return;

      clearTimeout(entry.timer);
      pending.delete(response.id);
      entry.resolve(response.approved);
    },
  };
}
