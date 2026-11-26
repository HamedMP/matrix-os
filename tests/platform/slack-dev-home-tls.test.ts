import { once } from "node:events";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSlackDevHomeDispatcher, loadSlackDevIngressCertificate } from "../../packages/platform/src/slack-dev-home-tls.js";
import { makeSlackDevCertificate } from "./slack-dev-certificate-fixture.js";

let approved: ReturnType<typeof makeSlackDevCertificate>;
let untrusted: ReturnType<typeof makeSlackDevCertificate>;

beforeAll(() => {
  approved = makeSlackDevCertificate();
  untrusted = makeSlackDevCertificate();
});

afterAll(() => {
  approved?.close();
  untrusted?.close();
});

it("rejects missing, malformed, bundled, expired and wrong-host trust config", () => {
  for (const pem of [undefined, "not a PEM", approved.cert + untrusted.cert]) {
    expect(() => loadSlackDevIngressCertificate(pem)).toThrow("Slack Dev ingress certificate unavailable");
  }
  const wrongHost = makeSlackDevCertificate("elsewhere.local");
  try {
    expect(() => loadSlackDevIngressCertificate(wrongHost.cert)).toThrow("Slack Dev ingress certificate unavailable");
    expect(() => loadSlackDevIngressCertificate(wrongHost.issueUnpinnedLeaf().cert)).toThrow("Slack Dev ingress certificate unavailable");
  } finally {
    wrongHost.close();
  }
  vi.setSystemTime(new Date(Date.now() + 2 * 86_400_000));
  try {
    expect(() => loadSlackDevIngressCertificate(approved.cert)).toThrow("Slack Dev ingress certificate unavailable");
  } finally {
    vi.useRealTimers();
  }
});

it("sends an RPC to the configured certificate on the registered IP using the Dev hostname", async () => {
  const { request, server, origin } = await startFixture(approved);
  const dispatcher = createSlackDevHomeDispatcher(loadSlackDevIngressCertificate(approved.cert));
  try {
    const response = await fetch(origin + "/api/internal/slack/context", {
      method: "POST", body: "pinned", dispatcher, signal: AbortSignal.timeout(1500),
    } as RequestInit);
    expect(await response.json()).toEqual({ accepted: true });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({ path: "/api/internal/slack/context", sni: "customer-vps.matrix-os.local" });
  } finally {
    await dispatcher.destroy();
    server.close();
  }
});

it("keeps the RPC body off connections presenting an unrelated or CA-trusted but unpinned leaf", async () => {
  for (const certificate of [untrusted, approved.issueUnpinnedLeaf()]) {
    const { request, server, origin } = await startFixture(certificate);
    const dispatcher = createSlackDevHomeDispatcher(loadSlackDevIngressCertificate(approved.cert));
    try {
      await expect(fetch(origin + "/api/internal/slack/context", {
        method: "POST", body: "pinned", dispatcher, signal: AbortSignal.timeout(1500),
      } as RequestInit)).rejects.toThrow("fetch failed");
      expect(request).not.toHaveBeenCalled();
    } finally {
      await dispatcher.destroy();
      server.close();
    }
  }
});

async function startFixture(certificate: { key: string; cert: string }) {
  const request = vi.fn();
  const server = createServer({ key: certificate.key, cert: certificate.cert }, (req, res) => {
    request({ path: req.url, sni: (req.socket as import("node:tls").TLSSocket).servername });
    res.writeHead(200, { "content-type": "application/json" }).end('{"accepted":true}');
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, request, origin: "https://127.0.0.1:" + (server.address() as AddressInfo).port };
}
