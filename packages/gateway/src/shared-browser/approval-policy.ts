import type { SharedBrowserAction } from "@matrix-os/contracts";
import { SharedBrowserError, type SharedBrowserBinding } from "./broker.js";

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
  if (request.signal.aborted) throw new SharedBrowserError("browser_changed");
  // Stop and takeover must release a logical permission wait even when a
  // failed authority callback does not settle. No physical action runs here.
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(new SharedBrowserError("browser_changed"));
    request.signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (request.signal.aborted) throw new SharedBrowserError("browser_changed");
      return policy.authorizeAction({ ...request,
        binding: Object.freeze({ ...request.binding }), action: Object.freeze({ ...request.action }),
      });
    }).then(resolve, reject).finally(() => request.signal.removeEventListener("abort", abort));
    if (request.signal.aborted) abort();
  }).catch((error: unknown) => {
    // This boundary has not called Chrome. Storage/proof failures must not be
    // classified as physical driver failures or carry a dispatched marker.
    if (error instanceof SharedBrowserError) throw new SharedBrowserError(error.code === "browser_unavailable" ? "browser_changed" : error.code);
    console.warn("[shared-browser-approval] Authorization unavailable", error instanceof Error ? error.name : "UnknownError");
    throw new SharedBrowserError("browser_changed");
  });
  if (request.signal.aborted) throw new SharedBrowserError("browser_changed");
}
