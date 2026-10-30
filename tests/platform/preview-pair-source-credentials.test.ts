import { describe, expect, it, vi } from "vitest";
import { readPreviewPairSourceCredentials } from "../../packages/platform/src/preview-pair/source-credentials.js";
import type { PreviewPairSourceProfile } from "../../packages/platform/src/preview-pair/source-profile.js";

const seed = (byte: number) => Buffer.alloc(32, byte).toString("base64url");
const profile: PreviewPairSourceProfile = { project: "matrix-test", projectNumber: "123456789012", region: "europe-west1",
  service: "matrix-platform-preview", r2Prefix: "preview/pairs", activeTicketKeyId: "preview-a", operatorSecret: "o".repeat(40),
  bindings: { CLERK_SECRET_KEY: { ref: "preview-clerk", version: "1" }, PLATFORM_DATABASE_URL: { ref: "preview-db", version: "2" },
    MATRIX_COLLABORATION_TICKET_KEYS: { ref: "preview-tickets", version: "3" }, PLATFORM_SECRET: { ref: "preview-host", version: "4" },
    PLATFORM_JWT_SECRET: { ref: "preview-jwt", version: "5" }, EDGE_ROUTER_SECRET: { ref: "preview-edge", version: "6" } } };
const control = { PLATFORM_SECRET: "c".repeat(40), PLATFORM_JWT_SECRET: seed(9), EDGE_ROUTER_SECRET: "e".repeat(40),
  CLERK_SECRET_KEY: "sk_live_" + "c".repeat(40), GITHUB_TOKEN: "github-" + "g".repeat(40), HETZNER_API_TOKEN: "v".repeat(64), MATRIX_PREVIEW_RUNTIME_SECRET: "b".repeat(40),
  MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "control-a", MATRIX_COLLABORATION_TICKET_KEYS: JSON.stringify({ "control-a": seed(2) }) };
function setup() {
  const values: Record<string, string> = { "preview-clerk": "sk_test_previewFixture", "preview-db": "postgresql://fixture@localhost/preview_test",
    "preview-tickets": JSON.stringify({ "preview-a": seed(7) }), "preview-host": "h".repeat(40),
    "preview-jwt": "t".repeat(40), "preview-edge": "r".repeat(40) };
  const read = vi.fn(async (binding: { ref: string }, signal: AbortSignal) => { signal.throwIfAborted(); return values[binding.ref]; });
  return { values, read };
}
describe("resolved Preview credentials cannot reuse control authority", () => {
  it("loads exactly the six pinned versions with bounded signals", async () => {
    const { read } = setup(), result = await readPreviewPairSourceCredentials(profile, control, read);
    expect(result.PLATFORM_SECRET).toBe("h".repeat(40));
    expect(result.PLATFORM_JWT_SECRET).toBe("t".repeat(40));
    expect(read).toHaveBeenCalledTimes(6);
    expect(read.mock.calls.map(([binding]) => binding)).toEqual(Object.values(profile.bindings));
    for (const [, signal] of read.mock.calls) expect(signal).toBeInstanceOf(AbortSignal);
  });
  it.each(["control host", "bank", "operator", "duplicate host", "live Clerk", "control ticket", "invalid ticket", "bad database", "control Clerk as host", "provider token as host", "GitHub token as host", "preview signer as host", "control JWT as signer", "encoded domain alias"])("rejects %s", async fault => {
    const { values, read } = setup();
    if (fault === "control host") values["preview-host"] = control.PLATFORM_SECRET;
    if (fault === "bank") values["preview-host"] = control.MATRIX_PREVIEW_RUNTIME_SECRET;
    if (fault === "operator") values["preview-host"] = profile.operatorSecret;
    if (fault === "duplicate host") values["preview-host"] = values["preview-jwt"];
    if (fault === "live Clerk") values["preview-clerk"] = "sk_live_previewFixture";
    if (fault === "control ticket") values["preview-tickets"] = JSON.stringify({ "preview-a": seed(2) });
    if (fault === "invalid ticket") values["preview-tickets"] = "{}";
    if (fault === "control Clerk as host") values["preview-host"] = control.CLERK_SECRET_KEY;
    if (fault === "provider token as host") values["preview-host"] = control.HETZNER_API_TOKEN;
    if (fault === "GitHub token as host") values["preview-host"] = control.GITHUB_TOKEN;
    if (fault === "preview signer as host") values["preview-host"] = seed(7);
    if (fault === "encoded domain alias") {
      const encoded = seed(5), alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      values["preview-jwt"] = encoded;
      values["preview-host"] = encoded.slice(0, -1) + alphabet[alphabet.indexOf(encoded.at(-1)!) + 1];
    }
    if (fault === "control JWT as signer") values["preview-tickets"] = JSON.stringify({ "preview-a": control.PLATFORM_JWT_SECRET });
    if (fault === "bad database") values["preview-db"] = "https://customer.example/db";
    await expect(readPreviewPairSourceCredentials(profile, control, read)).rejects.toThrow("unavailable");
  });
});
