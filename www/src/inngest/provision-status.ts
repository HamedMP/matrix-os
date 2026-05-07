const DEFAULT_APP_URL = "https://app.matrix-os.com";

export type ProvisionResult = {
  alreadyProvisioned?: boolean;
  runtime?: string;
  machineId?: string;
};

export type VerificationTarget =
  | {
      runtime: "customer_vps";
      statusUrl: string;
    }
  | {
      runtime: "legacy_container";
      containerUrl: string;
    };

export type CustomerVpsStatus = "provisioning" | "running" | "failed" | "recovering" | "deleted";

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

export function getSignupFallbackRedirectUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL
    ?? env.NEXT_PUBLIC_MATRIX_APP_URL
    ?? DEFAULT_APP_URL;
}

export function getProvisionVerificationTarget(
  platformApiUrl: string,
  handle: string,
  provisionResult: ProvisionResult,
): VerificationTarget {
  const baseUrl = stripTrailingSlash(platformApiUrl);
  if (provisionResult.runtime === "customer_vps" && provisionResult.machineId) {
    return {
      runtime: "customer_vps",
      statusUrl: `${baseUrl}/vps/${encodeURIComponent(provisionResult.machineId)}/status`,
    };
  }

  return {
    runtime: "legacy_container",
    containerUrl: `${baseUrl}/containers/${encodeURIComponent(handle)}`,
  };
}

export function isCustomerVpsUsableStatus(status: string): status is CustomerVpsStatus {
  return status === "provisioning" || status === "running" || status === "recovering";
}
