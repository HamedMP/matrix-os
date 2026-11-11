import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureEdgeRequestDeadlines,
  EDGE_HEADERS_TIMEOUT_MS,
  EDGE_REQUEST_TIMEOUT_MS,
} from "@matrix-os/contracts/http-request-deadlines";
import { createFileBlobRoutes } from "../../packages/gateway/src/file-blob-routes.js";

const TEST_DEADLINES = { requestTimeoutMs: 1_000, headersTimeoutMs: 500 };

function rawRequest(port: number, head: string, drip?: { chunk: Buffer; everyMs: number }) {
  return new Promise<{ response: string; elapsedMs: number }>((resolve, reject) => {
    const started = Date.now();
    const socket = connect(port, "127.0.0.1");
    let response = "";
    let timer: ReturnType<typeof setInterval> | undefined;
    socket.on("connect", () => {
      socket.write(head);
      if (drip) {
        timer = setInterval(() => {
          if (!socket.destroyed) socket.write(drip.chunk);
        }, drip.everyMs);
      }
    });
    socket.on("data", (data) => { response += data.toString("latin1"); });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNRESET" && error.code !== "EPIPE") reject(error);
    });
    socket.on("close", () => {
      clearInterval(timer);
      resolve({ response, elapsedMs: Date.now() - started });
    });
  });
}

describe("edge request deadlines", () => {
  let homePath: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-edge-deadline-"));
    const app = createFileBlobRoutes({ homePath });
    server = await new Promise<Server>((resolve) => {
      const started = serve({
        fetch: app.fetch,
        hostname: "127.0.0.1",
        port: 0,
        serverOptions: { connectionsCheckingInterval: 50 },
      }, () => resolve(started as Server)) as Server;
    });
    configureEdgeRequestDeadlines(server, TEST_DEADLINES);
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(homePath, { recursive: true, force: true });
  });

  it("closes an upload whose body keeps trickling past the total deadline", async () => {
    const declared = 1024 * 1024;
    const { response, elapsedMs } = await rawRequest(
      port,
      `PUT /blob?path=uploads/slow.bin HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/octet-stream\r\nContent-Length: ${declared}\r\n\r\n`,
      { chunk: Buffer.alloc(64, 1), everyMs: 50 },
    );

    expect(response).toMatch(/^HTTP\/1\.1 408 /);
    expect(response).not.toContain("uploads");
    expect(elapsedMs).toBeGreaterThanOrEqual(TEST_DEADLINES.requestTimeoutMs - 50);
    expect(elapsedMs).toBeLessThan(TEST_DEADLINES.requestTimeoutMs + 1_500);
    await expect(readdir(join(homePath, "uploads"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("closes a connection whose headers never finish", async () => {
    const { response, elapsedMs } = await rawRequest(
      port,
      "PUT /blob?path=uploads/headers.bin HTTP/1.1\r\nHost: localhost\r\n",
      { chunk: Buffer.from("X-Pad: 1\r\n"), everyMs: 50 },
    );

    expect(response).toMatch(/^HTTP\/1\.1 408 /);
    expect(elapsedMs).toBeLessThan(TEST_DEADLINES.headersTimeoutMs + 1_500);
  });

  it("keeps a normal upload at the existing size cap working", async () => {
    const body = Buffer.alloc(10 * 1024 * 1024, 7);
    const response = await fetch(`http://127.0.0.1:${port}/blob?path=uploads/normal.bin`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, size: body.byteLength });
    expect((await readFile(join(homePath, "uploads", "normal.bin"))).equals(body)).toBe(true);
  });

  it("does not count handler time after the request has been received", async () => {
    const slowHandler = serve({
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, TEST_DEADLINES.requestTimeoutMs + 500));
        return new Response("done");
      },
      hostname: "127.0.0.1",
      port: 0,
      serverOptions: { connectionsCheckingInterval: 50 },
    }) as Server;
    configureEdgeRequestDeadlines(slowHandler, TEST_DEADLINES);
    await new Promise<void>((resolve) => slowHandler.once("listening", () => resolve()));
    try {
      const response = await fetch(`http://127.0.0.1:${(slowHandler.address() as AddressInfo).port}/`, {
        method: "POST",
        body: "small",
        signal: AbortSignal.timeout(10_000),
      });
      await expect(response.text()).resolves.toBe("done");
    } finally {
      slowHandler.closeAllConnections();
      await new Promise<void>((resolve) => slowHandler.close(() => resolve()));
    }
  });

  it("applies the production deadlines by default and rejects disabled ones", () => {
    const target = { headersTimeout: 0, requestTimeout: 0 };
    configureEdgeRequestDeadlines(target);
    expect(target).toEqual({ headersTimeout: EDGE_HEADERS_TIMEOUT_MS, requestTimeout: EDGE_REQUEST_TIMEOUT_MS });
    expect(EDGE_REQUEST_TIMEOUT_MS).toBe(300_000);
    expect(EDGE_HEADERS_TIMEOUT_MS).toBe(60_000);

    expect(() => configureEdgeRequestDeadlines(target, { requestTimeoutMs: 0, headersTimeoutMs: 0 })).toThrow();
    expect(() => configureEdgeRequestDeadlines(target, { requestTimeoutMs: 1_000, headersTimeoutMs: 2_000 })).toThrow();
    expect(() => configureEdgeRequestDeadlines({})).toThrow();
  });

  it("is applied to the gateway and platform edge servers", () => {
    for (const entrypoint of ["packages/gateway/src/server.ts", "packages/platform/src/platform-startup.ts"]) {
      const source = readFileSync(join(process.cwd(), entrypoint), "utf8");
      expect(source, entrypoint).toMatch(/const server = serve\([\s\S]{0,200}?\);\s*\n\s*configureEdgeRequestDeadlines\(server\);/);
    }
  });
});
