import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChError, createChClient } from "../../packages/hostd/src/ch-client.js";

interface Recorded {
  method: string | undefined;
  url: string | undefined;
  body: string;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let dir: string;
let socketPath: string;
let server: Server;
let recorded: Recorded[];
let handler: Handler;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hostd-ch-"));
  socketPath = join(dir, "ch.sock");
  recorded = [];
  handler = (_req, res) => {
    res.writeHead(204);
    res.end();
  };
  server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      recorded.push({ method: req.method, url: req.url, body });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const signal = () => AbortSignal.timeout(5_000);

describe("Cloud Hypervisor client", () => {
  it("info parses state and memory_actual_size", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ state: "Running", memory_actual_size: 2147483648, config: {} }));
    };
    const client = createChClient(socketPath);
    try {
      await expect(client.info(signal())).resolves.toEqual({
        state: "Running",
        memoryActualBytes: 2147483648,
      });
      expect(recorded[0]).toMatchObject({ method: "GET", url: "/api/v1/vm.info" });
    } finally {
      await client.close();
    }
  });

  it("snapshot sends PUT /api/v1/vm.snapshot with destination_url file://<dir>", async () => {
    const client = createChClient(socketPath);
    try {
      await client.snapshot("/var/lib/matrix-hostd/snapshots/vm-1", signal());
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ method: "PUT", url: "/api/v1/vm.snapshot" });
      expect(JSON.parse(recorded[0]!.body)).toEqual({
        destination_url: "file:///var/lib/matrix-hostd/snapshots/vm-1",
      });
    } finally {
      await client.close();
    }
  });

  it("resizeMemory sends PUT /api/v1/vm.resize with desired_ram", async () => {
    const client = createChClient(socketPath);
    try {
      await client.resizeMemory(4294967296, signal());
      expect(recorded[0]).toMatchObject({ method: "PUT", url: "/api/v1/vm.resize" });
      expect(JSON.parse(recorded[0]!.body)).toEqual({ desired_ram: 4294967296 });
    } finally {
      await client.close();
    }
  });

  it("rejects a relative snapshot destination and a non-integer memory size without calling the API", async () => {
    const client = createChClient(socketPath);
    try {
      await expect(client.snapshot("snapshots/vm-1", signal())).rejects.toBeInstanceOf(RangeError);
      await expect(client.resizeMemory(1.5, signal())).rejects.toBeInstanceOf(RangeError);
      expect(recorded).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("pause, resume, powerButton and shutdownVmm send PUT to their endpoints", async () => {
    const client = createChClient(socketPath);
    try {
      await client.pause(signal());
      await client.resume(signal());
      await client.powerButton(signal());
      await client.shutdownVmm(signal());
      expect(recorded.map((r) => `${r.method} ${r.url}`)).toEqual([
        "PUT /api/v1/vm.pause",
        "PUT /api/v1/vm.resume",
        "PUT /api/v1/vm.power-button",
        "PUT /api/v1/vmm.shutdown",
      ]);
    } finally {
      await client.close();
    }
  });

  it("a 500 response throws ChError rejected without the server body in the message", async () => {
    handler = (_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("Error from API: secret-internal-detail /srv/vm-1/disk.raw");
    };
    const client = createChClient(socketPath);
    try {
      const error = await client.pause(signal()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChError);
      expect((error as ChError).code).toBe("rejected");
      expect((error as ChError).message).not.toContain("secret-internal-detail");
      expect((error as ChError).message).not.toContain(socketPath);
    } finally {
      await client.close();
    }
  });

  it("an aborted signal throws ChError timeout", async () => {
    handler = () => {
      // never respond
    };
    const client = createChClient(socketPath);
    try {
      const error = await client.info(AbortSignal.timeout(50)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChError);
      expect((error as ChError).code).toBe("timeout");
    } finally {
      await client.close();
    }
  });

  it("a missing socket throws ChError unreachable without the socket path", async () => {
    const missing = join(dir, "missing.sock");
    const client = createChClient(missing);
    try {
      const error = await client.info(signal()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChError);
      expect((error as ChError).code).toBe("unreachable");
      expect((error as ChError).message).not.toContain(missing);
    } finally {
      await client.close();
    }
  });

  it("an info response with an unknown state throws ChError rejected", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ state: "Exploded", memory_actual_size: 1 }));
    };
    const client = createChClient(socketPath);
    try {
      const error = await client.info(signal()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChError);
      expect((error as ChError).code).toBe("rejected");
    } finally {
      await client.close();
    }
  });
});
