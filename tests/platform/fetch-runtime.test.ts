import { execFile } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo, type Server } from "node:net";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundledUndiciNeedsReplacement,
  installPlatformFetchRuntime,
} from "../../packages/platform/src/fetch-runtime";

const execFileAsync = promisify(execFile);
const BODY_BYTES = 64 * 1024;

// nodejs/undici#5360: a 64 KiB non-keep-alive body that arrives in one socket read
// pauses the HTTP/1 parser on backpressure; the FIN then hits `assert(!this.paused)`.
function listenCrashScenario(): Promise<Server> {
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${BODY_BYTES}\r\nConnection: close\r\n\r\n`);
      socket.write(Buffer.alloc(BODY_BYTES, 0x61));
      socket.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("bundledUndiciNeedsReplacement", () => {
  it("replaces every bundled undici below the major that fixed the paused-parser crash", () => {
    expect(bundledUndiciNeedsReplacement("7.29.1")).toBe(true);
    expect(bundledUndiciNeedsReplacement("8.0.0")).toBe(false);
    expect(bundledUndiciNeedsReplacement("8.11.2")).toBe(false);
    expect(bundledUndiciNeedsReplacement(undefined)).toBe(true);
    expect(bundledUndiciNeedsReplacement("unknown")).toBe(true);
  });
});

describe("installPlatformFetchRuntime", () => {
  it("leaves fetch alone when the runtime already bundles a fixed undici", () => {
    const original = globalThis.fetch;
    const target = { fetch: original, FormData: globalThis.FormData };
    expect(installPlatformFetchRuntime(target, "8.11.2")).toBe(false);
    expect(target.fetch).toBe(original);
    expect(target.FormData).toBe(globalThis.FormData);
  });

  it("posts a FormData built from the installed global as real multipart", async () => {
    // nodejs/undici#4285: a FormData from a different undici copy fails undici's
    // brand check and is sent as the string "[object FormData]" with text/plain.
    const target = { fetch: globalThis.fetch, FormData: globalThis.FormData };
    expect(installPlatformFetchRuntime(target, "7.29.1")).toBe(true);
    expect(target.FormData).not.toBe(globalThis.FormData);

    const received: { contentType?: string; body: Buffer[] } = { body: [] };
    const server = createHttpServer((req, res) => {
      received.contentType = req.headers["content-type"];
      req.on("data", (chunk: Buffer) => received.body.push(chunk));
      req.on("end", () => {
        res.writeHead(200);
        res.end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;

    const form = new target.FormData();
    form.set("model", "gpt-4o-mini-transcribe");
    form.set("file", new Blob([Buffer.from("RIFF....WAVE")], { type: "audio/wav" }), "audio.wav");
    const response = await target.fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: form });
    expect(response.status).toBe(200);

    expect(received.contentType).toMatch(/^multipart\/form-data; boundary=/);
    const body = Buffer.concat(received.body).toString("latin1");
    expect(body).not.toContain("[object FormData]");
    expect(body).toContain('name="model"\r\n\r\ngpt-4o-mini-transcribe');
    expect(body).toContain('name="file"; filename="audio.wav"');
    expect(body).toContain("RIFF....WAVE");
  });

  it("survives an unread non-keep-alive body whose peer closes under backpressure", async () => {
    const target = { fetch: globalThis.fetch, FormData: globalThis.FormData };
    expect(installPlatformFetchRuntime(target, "7.29.1")).toBe(true);
    expect(target.fetch).not.toBe(globalThis.fetch);

    const server = await listenCrashScenario();
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const response = await target.fetch(`http://127.0.0.1:${port}/`);
    // Leave the body unread while the FIN arrives; with Node's bundled undici 7
    // this is where the process dies with an uncatchable AssertionError.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const body = await response.arrayBuffer();
    expect(body.byteLength).toBe(BODY_BYTES);
  });

  it.skipIf(!bundledUndiciNeedsReplacement())(
    "documents that this runtime's bundled fetch still crashes on that scenario",
    async () => {
      const server = await listenCrashScenario();
      servers.push(server);
      const { port } = server.address() as AddressInfo;
      const script = `
        const response = await fetch("http://127.0.0.1:${port}/");
        await new Promise((resolve) => setTimeout(resolve, 300));
        await response.arrayBuffer();
        console.log("no crash");
      `;
      const result = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], { timeout: 10_000 })
        .then((output) => ({ code: 0, stderr: output.stderr, stdout: output.stdout }))
        .catch((error: { code?: number; stderr?: string; stdout?: string }) => ({
          code: error.code ?? -1,
          stderr: error.stderr ?? "",
          stdout: error.stdout ?? "",
        }));
      // When this starts passing with "no crash", Node ships the fix and
      // fetch-runtime.ts can be deleted.
      expect(result.stdout).not.toContain("no crash");
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("ERR_ASSERTION");
    },
  );
});
