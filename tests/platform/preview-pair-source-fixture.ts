import { vi } from "vitest";
import { previewPairConfigurationFixture } from "./preview-pair-test-support.js";

/** Source-only credentials are explicit synthetic ports, never live acceptance. */
export function createPreviewPairSourceFixture(databaseUrl = "postgresql://fixture@localhost/preview_test") {
  const initial = previewPairConfigurationFixture();
  initial.MATRIX_PREVIEW_PAIR_CLERK_PUBLISHABLE_KEY = `pk_test_${Buffer.from(`${new URL(initial.MATRIX_PREVIEW_PAIR_IDENTITY_ISSUER).hostname}$`).toString("base64")}`;
  const profile = { project: "matrix-test", projectNumber: "123456789012", region: "europe-west1", service: "matrix-platform-preview",
    r2Prefix: "preview/pairs", activeTicketKeyId: "preview-a", bindings: {
      CLERK_SECRET_KEY: { ref: initial.MATRIX_PREVIEW_PAIR_CLERK_SECRET_REF, version: "1" },
      PLATFORM_DATABASE_URL: { ref: initial.MATRIX_PREVIEW_PAIR_DATABASE_SECRET_REF, version: "2" },
      MATRIX_COLLABORATION_TICKET_KEYS: { ref: initial.MATRIX_PREVIEW_PAIR_TICKET_KEYS_SECRET_REF, version: "3" },
      PLATFORM_SECRET: { ref: "matrix-preview-host", version: "4" },
      PLATFORM_JWT_SECRET: { ref: "matrix-preview-jwt", version: "5" }, EDGE_ROUTER_SECRET: { ref: "matrix-preview-edge", version: "6" },
    } };
  const env = { ...initial, MATRIX_PREVIEW_PAIR_SOURCE_PROFILE: JSON.stringify(profile), MATRIX_PREVIEW_PAIR_OPERATOR_SECRET: "o".repeat(40),
    PLATFORM_SECRET: "c".repeat(40), PLATFORM_JWT_SECRET: "j".repeat(40), EDGE_ROUTER_SECRET: "e".repeat(40),
    CLERK_SECRET_KEY: "sk_test_control_fixture", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("control-test.clerk.accounts.dev$").toString("base64")}`,
    GITHUB_TOKEN: "fixture-github-token" };
  const credentials = { CLERK_SECRET_KEY: "sk_test_preview_fixture", PLATFORM_DATABASE_URL: databaseUrl,
    MATRIX_COLLABORATION_TICKET_KEYS: JSON.stringify({ "preview-a": Buffer.alloc(32, 7).toString("base64url") }),
    PLATFORM_SECRET: "h".repeat(40), PLATFORM_JWT_SECRET: "t".repeat(40), EDGE_ROUTER_SECRET: "r".repeat(40) };
  const google = { accessToken: vi.fn(async (signal: AbortSignal) => { signal.throwIfAborted(); return "fixture-google-token"; }),
    secret: vi.fn(async (binding: { ref: string; version: string }, signal: AbortSignal) => {
      signal.throwIfAborted();
      const name = Object.entries(profile.bindings).find(([, value]) => value.ref === binding.ref && value.version === binding.version)?.[0] as keyof typeof credentials;
      if (!name) throw new Error("Unknown fixture secret binding");
      return credentials[name];
    }) };
  return { env, profile, credentials, google };
}
