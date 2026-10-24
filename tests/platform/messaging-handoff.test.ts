import { describe, expect, it } from "vitest";
import { createMessagingHandoffRoutes } from "../../packages/platform/src/whatsapp/handoff-routes.js";
import { buildPostAuthRedirectPath, normalizePostAuthRedirectPath } from "../../packages/platform/src/request-routing.js";
import { getAuthPage } from "../../packages/platform/src/auth-pages.js";
describe("mobile app handoff", () => {
  it("serves a narrow public association and authenticated web fallback without credentials", async () => {
    const app = createMessagingHandoffRoutes();
    const association = await app.request(
      "/.well-known/apple-app-site-association",
    );
    expect(association.status).toBe(200);
    expect((await association.json()).applinks.details[0]).toEqual({
      appID: "PX4JL74Y2K.com.matrixos.mobile",
      paths: ["/open"],
    });
    const response = await app.request("/open?chat=chat_12345678");
    const html = await response.text();
    expect(html).toContain("matrixos://open?chat=chat_12345678");
    expect(html).toContain(
      "/?chat=chat_12345678&amp;launch=__chat__&amp;runtime=primary",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it.each([
    "chat=../../secrets",
    "chat=a&chat=b",
    "chat=chat_12345678&token=secret",
    "redirect=https://evil.test",
  ])("rejects %s", async (query) => {
    expect(
      (await createMessagingHandoffRoutes().request("/open?" + query)).status,
    ).toBe(400);
  });
  it("preserves a signed-out browser Chat target through the sign-in redirect", async () => {
    const html = await (await createMessagingHandoffRoutes().request("/open?chat=chat_12345678")).text();
    const fallback = html.match(/class="secondary" href="([^"]+)"/)![1].replaceAll("&amp;", "&");
    const target = normalizePostAuthRedirectPath(buildPostAuthRedirectPath("https://app.matrix-os.com" + fallback));
    const query = new URL(target, "https://app.matrix-os.com").searchParams;
    expect(query.get("chat")).toBe("chat_12345678");
    expect(query.get("launch")).toBe("__chat__");
    expect(query.get("runtime")).toBe("primary");
    const signIn = getAuthPage("pk_test_fixture", "sign-in", "nonce", target, "https://app.matrix-os.com");
    expect(JSON.parse(signIn.match(/var redirectTarget = (.+);/)![1])).toBe(target);
  });
  it.each(["chat=../../secret", "chat=chat_12345678&chat=chat_87654321", "launch=__chat__&token=secret"])(
    "does not carry invalid or ambiguous Chat navigation through auth: %s", (query) => {
      expect(buildPostAuthRedirectPath("https://app.matrix-os.com/?" + query)).toBe("/");
    },
  );
});
