import { describe, expect, it } from "vitest";
import { appDomainServiceWorkerResponse } from "../../packages/platform/src/app-domain-service-worker.js";

describe("platform app-domain service worker", () => {
  it("does not take over open tabs during deploys and bypasses explicit VM routes", async () => {
    const response = appDomainServiceWorkerResponse();
    const source = await response.text();

    expect(source).not.toContain("self.skipWaiting()");
    expect(source).toContain('p.startsWith("/vm/")');
  });
});
