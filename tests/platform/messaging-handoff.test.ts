import { describe, expect, it } from "vitest";
import { createMessagingHandoffRoutes } from "../../packages/platform/src/whatsapp/handoff-routes.js";
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
});
