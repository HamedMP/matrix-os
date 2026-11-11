import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import {
  createPinnedFetch,
  createValidatedLookup,
  isPublicAddress,
  PinnedAddressBlockedError,
  type PinnedAddress,
} from "../../packages/kernel/src/security/pinned-fetch.js";

function sequenceResolver(...answers: PinnedAddress[][]) {
  const calls: string[] = [];
  const resolve = async (hostname: string) => {
    calls.push(hostname);
    return answers[Math.min(calls.length - 1, answers.length - 1)]!;
  };
  return { resolve, calls };
}

function rootCause(error: unknown): unknown {
  let current = error;
  while (current instanceof Error && current.cause) current = current.cause;
  return current;
}

describe("pinned fetch transport", () => {
  let server: Server;
  let port: number;
  let hits: IncomingHttpHeaders[];

  beforeEach(async () => {
    hits = [];
    server = createServer((req, res) => {
      hits.push(req.headers);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("internal");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("connects only to the validated address while keeping the requested Host", async () => {
    const { resolve, calls } = sequenceResolver([{ address: "127.0.0.1", family: 4 }]);
    const pinnedFetch = createPinnedFetch({
      resolve,
      isAllowedAddress: (address) => address === "127.0.0.1",
    });

    const response = await pinnedFetch(`http://pinned.example:${port}/page`);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("internal");
    expect(calls).toEqual(["pinned.example"]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.host).toBe(`pinned.example:${port}`);
  });

  it("refuses a rebinding answer that differs from the preflighted one", async () => {
    const rebinding = () => sequenceResolver(
      [{ address: "93.184.216.34", family: 4 }],
      [{ address: "127.0.0.1", family: 4 }],
    );

    // Control: a hostname-based fetch after a passing preflight reaches the
    // internal listener, which is the window this transport closes.
    const control = rebinding();
    const preflight = await control.resolve("rebind.example");
    expect(preflight.every((entry) => isPublicAddress(entry.address))).toBe(true);
    const unpinned = new Agent({
      connect: {
        lookup: (hostname, options, callback) => {
          void control.resolve(hostname).then((records) => {
            if (options.all) callback(null, records);
            else callback(null, records[0]!.address, records[0]!.family);
          });
        },
      },
    });
    const leaked = await undiciFetch(`http://rebind.example:${port}/`, { dispatcher: unpinned });
    await leaked.text();
    await unpinned.close();
    expect(hits).toHaveLength(1);

    hits = [];
    const pinned = rebinding();
    expect((await pinned.resolve("rebind.example")).every((entry) => isPublicAddress(entry.address))).toBe(true);
    const pinnedFetch = createPinnedFetch({ resolve: pinned.resolve });

    const failure = await pinnedFetch(`http://rebind.example:${port}/`).catch((error: unknown) => error);

    expect(rootCause(failure)).toBeInstanceOf(PinnedAddressBlockedError);
    expect(pinned.calls).toEqual(["rebind.example", "rebind.example"]);
    expect(hits).toHaveLength(0);
  });

  it("rejects a resolution that mixes public and private addresses", async () => {
    const { resolve } = sequenceResolver([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const failure = await createPinnedFetch({ resolve })(`http://mixed.example:${port}/`)
      .catch((error: unknown) => error);

    expect(rootCause(failure)).toBeInstanceOf(PinnedAddressBlockedError);
    expect(hits).toHaveLength(0);
  });

  it("rejects private literal addresses before dispatch", async () => {
    const pinnedFetch = createPinnedFetch({ resolve: async () => [] });

    await expect(pinnedFetch(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(PinnedAddressBlockedError);
    await expect(pinnedFetch("http://[::ffff:7f00:1]/")).rejects.toBeInstanceOf(PinnedAddressBlockedError);
    await expect(pinnedFetch("file:///etc/hosts")).rejects.toBeInstanceOf(PinnedAddressBlockedError);
    expect(hits).toHaveLength(0);
  });

  it("blocks loopback names resolved by system DNS", async () => {
    const failure = await createPinnedFetch()(`http://localhost:${port}/`).catch((error: unknown) => error);

    expect(rootCause(failure)).toBeInstanceOf(PinnedAddressBlockedError);
    expect(hits).toHaveLength(0);
  });

  it("returns only the requested family and fails closed when it is absent", async () => {
    const lookup = createValidatedLookup({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1::1", family: 6 }],
    });
    const call = (options: { all?: boolean; family?: number }) => new Promise<unknown>((resolve) => {
      lookup("dual.example", options as never, (error, address, family) => {
        resolve(error ?? { address, family });
      });
    });

    await expect(call({ all: true, family: 6 })).resolves.toEqual({
      address: [{ address: "2606:2800:220:1::1", family: 6 }],
      family: undefined,
    });
    await expect(call({ family: 4 })).resolves.toEqual({ address: "93.184.216.34", family: 4 });

    const v4Only = createValidatedLookup({ resolve: async () => [{ address: "93.184.216.34", family: 4 }] });
    const error = await new Promise<unknown>((resolve) => {
      v4Only("v4.example", { family: 6 } as never, (failure) => resolve(failure));
    });
    expect(error).toBeInstanceOf(PinnedAddressBlockedError);
  });

  it("fails closed when resolution hangs", async () => {
    const pinnedFetch = createPinnedFetch({
      resolve: () => new Promise<PinnedAddress[]>(() => {}),
      connectTimeoutMs: 50,
    });

    await expect(pinnedFetch(`http://slow-dns.example:${port}/`)).rejects.toThrow();
    expect(hits).toHaveLength(0);
  });
});
