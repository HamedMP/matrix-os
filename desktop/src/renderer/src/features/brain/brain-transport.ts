import type { BrainHttpTransport } from "@matrix-os/ui";
import { AppError } from "../../../../shared/app-error";
import type { ApiClient } from "../../lib/api";

/** The desktop gateway client as the Company Brain view's transport, bound to one runtime by the caller. */
export function desktopBrainTransport(api: ApiClient): BrainHttpTransport {
  return {
    get: (path, options) => call(api.get(path, options)),
    post: (path, body, options) => call(api.post(path, body, options)),
    patch: (path, body, options) => call(api.patch(path, body, options)),
    // The desktop delete always sends a JSON body; the brain routes accept an empty object.
    delete: (path, options) => call(api.delete(path, {}, options)),
  };
}

// The view knows five request categories; the two desktop-only ones map to their nearest state.
function call<T>(request: Promise<T>): Promise<T> {
  return request.catch((error: unknown) => {
    if (error instanceof AppError && error.category === "fatalSession") {
      throw new AppError("unauthorized", { cause: error, detail: error.detail });
    }
    if (error instanceof AppError && error.category === "misconfigured") {
      throw new AppError("offline", { cause: error, detail: error.detail });
    }
    throw error;
  });
}
