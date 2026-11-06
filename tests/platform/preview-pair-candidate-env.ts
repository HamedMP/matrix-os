import { previewPairManifestFixture } from "./preview-pair-test-support.js";
/** Synthetic startup environment only; these are never usable live credentials. */
export function candidateRuntimeEnvironment(): NodeJS.ProcessEnv {
  const m = previewPairManifestFixture();
  return { MATRIX_PREVIEW_PAIR_RUNTIME_ONLY: "true", MATRIX_PREVIEW_PAIR_ID: m.pairId,
    MATRIX_PREVIEW_PAIR_GENERATION: String(m.generation), MATRIX_PREVIEW_PAIR_PR: String(m.pr),
    MATRIX_PREVIEW_PAIR_ENABLED: "false", MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED: "false", CUSTOMER_VPS_ENABLED: "false",
    MATRIX_FUNDED_AI_RUNTIME_ENABLED: "false", MATRIX_PREVIEW_RUNTIME_ACCESS_ENABLED: "false",
    PLATFORM_PUBLIC_URL: m.apiOrigin, MATRIX_API_ORIGIN: m.apiOrigin, MATRIX_APP_ORIGIN: m.browserOrigin,
    NEXT_PUBLIC_MATRIX_APP_URL: m.browserOrigin, MATRIX_APP_DOMAIN_HOSTS: new URL(m.browserOrigin).hostname,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_fixture", CLERK_SECRET_KEY: "sk_test_fixture",
    PLATFORM_SECRET: "candidate-host-" + "h".repeat(40), PLATFORM_JWT_SECRET: "candidate-jwt-" + "j".repeat(40),
    EDGE_ROUTER_SECRET: "candidate-edge-" + "e".repeat(40) };
}
