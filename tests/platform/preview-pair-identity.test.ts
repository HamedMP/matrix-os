import { describe, expect, it, vi } from "vitest";
import { createPreviewPairIdentity } from "../../packages/platform/src/preview-pair/identity.js";
import { loadPreviewPairConfig, type EnabledPreviewPairConfig } from "../../packages/platform/src/preview-pair/config.js";
import { previewPairConfigurationFixture } from "./preview-pair-test-support.js";

const publishable = (host: string) => `pk_test_${Buffer.from(`${host}$`).toString("base64")}`;
function setup() {
  const env = previewPairConfigurationFixture();
  env.MATRIX_PREVIEW_PAIR_CLERK_PUBLISHABLE_KEY = publishable("pair-test.clerk.accounts.dev");
  env.MATRIX_PREVIEW_PAIR_MAINTAINER_ORG_ID = "org_internalTest";
  env.MATRIX_PREVIEW_PAIR_FIXTURES = JSON.stringify(JSON.parse(env.MATRIX_PREVIEW_PAIR_FIXTURES).map((fixture: Record<string, unknown>) => ({ ...fixture, organizationId: "org_pairFixture" })));
  const config = loadPreviewPairConfig(env) as EnabledPreviewPairConfig;
  const options = { config, controlSecret: "sk_test_control_fixture", previewSecret: "sk_test_preview_fixture",
    controlPublishableKey: publishable("control-test.clerk.accounts.dev") };
  let outsiderJoined = false;
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.clerk.com"); expect(init?.redirect).toBe("error"); expect(init?.signal).toBeInstanceOf(AbortSignal);
    const actor = decodeURIComponent(url.pathname.split("/")[3]);
    const token = new Headers(init?.headers).get("authorization");
    const organizations = token === `Bearer ${options.controlSecret}`
      ? actor === "user_requester" ? ["org_internalTest"] : []
      : ["user_pair_owner", "user_pair_member"].includes(actor) || outsiderJoined ? ["org_pairFixture"] : [];
    return Response.json({ data: organizations.map((id, i) => ({ id: `orgmem_fixture_${i}`, organization: { id } })), total_count: organizations.length });
  });
  return { options: { ...options, fetchImpl }, fetchImpl, joinOutsider: () => { outsiderJoined = true; } };
}
describe("preview identity source bindings", () => {
  it("checks maintainers against the control instance and fixtures against the separate test instance", async () => {
    const f = setup(), identity = createPreviewPairIdentity(f.options), signal = new AbortController().signal;
    expect(await identity.isMaintainer("user_requester")).toBe(true);
    expect(await identity.isMaintainer("user_pair_owner")).toBe(false);
    expect(await identity.verifyFixtures(signal)).toBe(true);
    expect(f.fetchImpl.mock.calls.filter(([, init]) => new Headers(init?.headers).get("authorization") === `Bearer ${f.options.previewSecret}`)).toHaveLength(3);
  });
  it("rechecks current fixture membership and fails if the outsider joins", async () => {
    const f = setup(), identity = createPreviewPairIdentity(f.options), signal = new AbortController().signal;
    expect(await identity.verifyFixtures(signal)).toBe(true);
    f.joinOutsider(); expect(await identity.verifyFixtures(signal)).toBe(false);
  });
  it("does not convert an unavailable identity service into a valid outsider denial", async () => {
    const f = setup(), identity = createPreviewPairIdentity(f.options);
    f.fetchImpl.mockResolvedValue(new Response("unavailable", { status: 503 }));
    await expect(identity.verifyFixtures(new AbortController().signal)).rejects.toThrow("unavailable");
  });
  it("propagates cancellation and rejects unknown fixture scopes without upstream requests", async () => {
    const f = setup(), identity = createPreviewPairIdentity(f.options), controller = new AbortController();
    expect(await identity.membership("user_pair_owner", "org_other", controller.signal)).toBe(false);
    controller.abort(); await expect(identity.verifyFixtures(controller.signal)).rejects.toThrow();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["live-preview", "reused-secret", "same-instance", "wrong-publishable-instance"])("rejects %s before network access", kind => {
    const f = setup(), options = { ...f.options, config: { ...f.options.config } };
    if (kind === "live-preview") options.previewSecret = "sk_live_fixture";
    if (kind === "reused-secret") options.previewSecret = options.controlSecret;
    if (kind === "same-instance") options.controlPublishableKey = options.config.clerkPublishableKey;
    if (kind === "wrong-publishable-instance") options.config.clerkPublishableKey = publishable("wrong.clerk.accounts.dev");
    expect(() => createPreviewPairIdentity(options)).toThrow("unavailable");
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
});
