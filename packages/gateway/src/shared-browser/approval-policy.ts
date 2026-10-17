import type { SharedBrowserAction } from "@matrix-os/contracts";
import type { SharedBrowserBinding } from "./broker.js";

export interface SharedBrowserApprovalRequest {
  binding: SharedBrowserBinding;
  action: SharedBrowserAction;
  signal: AbortSignal;
}
/** Created by the Gateway at lease registration, never by browser tool input. */
export interface SharedBrowserSupervisedPolicy {
  mode: "supervised";
  authorizeAction(request: SharedBrowserApprovalRequest): Promise<void>;
}

export async function authorizeSharedBrowserAction(policy: SharedBrowserSupervisedPolicy,
  request: SharedBrowserApprovalRequest): Promise<void> {
  request.signal.throwIfAborted();
  // Stop and takeover must release a logical permission wait even when a
  // failed authority callback does not settle. No physical action runs here.
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(request.signal.reason);
    request.signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      request.signal.throwIfAborted();
      return policy.authorizeAction({ ...request,
        binding: Object.freeze({ ...request.binding }), action: Object.freeze({ ...request.action }),
      });
    }).then(resolve, reject).finally(() => request.signal.removeEventListener("abort", abort));
    if (request.signal.aborted) abort();
  });
  request.signal.throwIfAborted();
}
