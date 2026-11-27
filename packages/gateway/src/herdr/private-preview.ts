import { isPrivatePreviewHandle } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { SAFE_PRINCIPAL_USER_ID } from "../request-principal.js";

export function isHerdrPreviewRuntime(env: NodeJS.ProcessEnv): boolean {
  return env.MATRIX_PREVIEW_RUNTIME === "true" || isPrivatePreviewHandle(env.MATRIX_HANDLE ?? "");
}

/** Platform's root-provisioned Private Preview binding, never derived from HTTP headers or a client-selected target. */
export function privatePreviewHerdrOwner(env: NodeJS.ProcessEnv): string | null {
  const handle = env.MATRIX_HANDLE;
  const owner = env.MATRIX_CLERK_USER_ID;
  const platform = env.PLATFORM_INTERNAL_URL;
  if (env.MATRIX_PREVIEW_RUNTIME !== "true" || env.MATRIX_COLLABORATION_DISABLED !== "1"
    || !handle || !isPrivatePreviewHandle(handle) || handle !== env.MATRIX_RUNTIME_SLOT
    || !owner || owner !== env.MATRIX_USER_ID || !SAFE_PRINCIPAL_USER_ID.test(owner)
    || !z.uuid().safeParse(env.MATRIX_MACHINE_ID).success
    || !/^[1-9][0-9]{0,9}$/.test(env.MATRIX_RUNTIME_TOKEN_EPOCH ?? "")
    || !platform || !URL.canParse(platform)) return null;
  const url = new URL(platform);
  if (url.protocol !== "https:" || url.origin !== platform
    || env.MATRIX_UPDATE_MANIFEST_BASE_URL !== platform + "/private-preview-updates/" + handle) return null;
  return owner;
}
