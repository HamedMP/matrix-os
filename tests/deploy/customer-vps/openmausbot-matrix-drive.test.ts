import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error This is an isolated Node script copied into the preview image.
import { driveToolReply } from "../../../scripts/openmausbot/matrix-drive-mcp.mjs";

const text = (result: { content: [{ text: string }] }) => result.content[0].text;

async function withBroker(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  test: (socketPath: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "omd-"));
  const socketPath = join(dir, "drive.sock");
  const server = createServer(handler);
  try {
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
    await test(socketPath);
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    await rm(dir, { recursive: true, force: true });
  }
}

describe("OpenMausBot Matrix Drive MCP", () => {
  it("advertises one read-only tool over stdio without an available broker", () => {
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];
    const child = spawnSync(process.execPath, ["scripts/openmausbot/matrix-drive-mcp.mjs"], {
      input: requests.map((request) => JSON.stringify(request) + "\n").join(""), encoding: "utf8", timeout: 3_000,
    });
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    const [initialized, listed] = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(initialized).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18" } });
    expect(listed.result.tools).toHaveLength(1);
    expect(listed.result.tools[0]).toMatchObject({ name: "matrix_read_drive_document", annotations: { readOnlyHint: true } });
  });

  it("sends only the exact file ID over Unix HTTP and returns bounded text", async () => {
    const body: unknown[] = [];
    await withBroker(async (request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/read");
      expect(request.headers.authorization).toBeUndefined();
      let raw = "";
      for await (const chunk of request) raw += chunk;
      body.push(JSON.parse(raw));
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        fileId: "fixture-01", name: "Fixture", content: "MATRIX_DRIVE_TEST_RECEIPT",
      }));
    }, async (socketPath) => {
      const result = await driveToolReply({ fileId: "fixture-01" }, socketPath);
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(text(result))).toEqual({ fileId: "fixture-01", name: "Fixture", content: "MATRIX_DRIVE_TEST_RECEIPT" });
      expect(body).toEqual([{ fileId: "fixture-01" }]);
    });
  });

  it("refuses injected identity locally and does not relay errors or mismatched content", async () => {
    let requests = 0;
    await withBroker((_, response) => {
      requests++;
      response.writeHead(requests === 1 ? 403 : 200, { "content-type": "application/json" }).end(JSON.stringify({
        fileId: "other-file", content: "NEVER_RELAY",
      }));
    }, async (socketPath) => {
      expect((await driveToolReply({ fileId: "fixture-01", ownerId: "other" }, socketPath)).isError).toBe(true);
      expect((await driveToolReply({ fileId: "../other" }, socketPath)).isError).toBe(true);
      expect(requests).toBe(0);
      for (let i = 0; i < 2; i++) {
        const result = await driveToolReply({ fileId: "fixture-01" }, socketPath);
        expect(result.isError).toBe(true);
        expect(text(result)).not.toContain("NEVER_RELAY");
      }
      expect(requests).toBe(2);
    });
  });

  it("mounts the Matrix-owned socket directory read-only without expanding workload network access", async () => {
    const [unit, launcher, dockerfile] = await Promise.all([
      readFile("scripts/openmausbot/matrix-openmausbot.service", "utf8"),
      readFile("scripts/openmausbot/matrix-openmausbot-run", "utf8"),
      readFile("scripts/openmausbot/Dockerfile", "utf8"),
    ]);
    expect(unit).toContain("Before=matrix-gateway.service");
    expect(unit).toContain("ExecStartPre=/opt/matrix/bin/matrix-openmausbot-run --prepare-drive");
    expect(launcher).toContain('readonly drive_dir=/run/matrix-openmausbot-drive');
    expect(launcher).toContain('install -d -o matrix -g matrix -m 0750 "$drive_dir"');
    expect(launcher).toContain('src=$drive_dir,dst=/matrix-drive,readonly');
    expect(launcher).toContain('iptables -I INPUT 1 -i "$bridge" -j REJECT');
    expect(dockerfile).toContain("COPY matrix-drive-mcp.mjs ./matrix-drive-mcp.mjs");
  });
});
