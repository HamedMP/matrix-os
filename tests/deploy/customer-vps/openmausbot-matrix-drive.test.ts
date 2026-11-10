import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error This is an isolated Node script copied into the preview image.
import { driveToolReply, integrationToolReply } from "../../../scripts/openmausbot/matrix-drive-mcp.mjs";

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

describe("OpenMausBot Matrix integration MCP", () => {
  const githubRead = { service: "github", action: "list_prs", params: { repo: "HamedMP/matrix-os", per_page: 1 } };

  it("advertises both read-only tools over stdio without an available broker", () => {
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
    expect(listed.result.tools).toHaveLength(2);
    expect(listed.result.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "matrix_read_drive_document", annotations: { readOnlyHint: true } }),
      expect.objectContaining({ name: "matrix_read_integration", annotations: { readOnlyHint: true } }),
    ]));
  });

  it("dispatches the generic tool over stdio and validates its inputs before contacting the broker", () => {
    const child = spawnSync(process.execPath, ["scripts/openmausbot/matrix-drive-mcp.mjs"], {
      input: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call", params: {
          name: "matrix_read_integration", arguments: { ...githubRead, connectionId: "injected" },
        },
      }) + "\n", encoding: "utf8", timeout: 3_000,
    });
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    expect(JSON.parse(child.stdout)).toMatchObject({ id: 1, result: {
      isError: true, content: [{ type: "text", text: expect.stringContaining("service, action, and params") }],
    } });
  });

  it("sends one exact integration request over the existing Unix socket", async () => {
    const inputs: unknown[] = [];
    const output = { data: [{ number: 1, title: "Synthetic public pull request" }] };
    await withBroker(async (request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/integration/read");
      expect(request.headers.authorization).toBeUndefined();
      let raw = "";
      for await (const chunk of request) raw += chunk;
      inputs.push(JSON.parse(raw));
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(output));
    }, async (socketPath) => {
      const result = await integrationToolReply(githubRead, socketPath);
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(text(result))).toEqual(output);
      expect(inputs).toEqual([githubRead]);
    });
  });

  it("rejects invalid integration arguments locally and withholds denied or oversized broker results", async () => {
    let nested: unknown = null;
    for (let i = 0; i < 8_000; i++) nested = [nested];
    const replies = [
      { status: 403, body: { data: "SECRET_RAW_UPSTREAM_ERROR" } },
      { status: 200, body: { data: "x".repeat(24 * 1024) } },
      { status: 200, body: { data: "ok", providerToken: "SECRET_WRONG_ENVELOPE" } },
    ];
    let requestCount = 0;
    await withBroker((_, response) => {
      const reply = replies[requestCount++]!;
      response.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
    }, async (socketPath) => {
      for (const input of [
        { ...githubRead, accountId: "injected" },
        { ...githubRead, service: "../../github" },
        { ...githubRead, action: "list/prs" },
        { ...githubRead, params: [] },
        { ...githubRead, params: { query: "x".repeat(16 * 1024) } },
        { ...githubRead, params: { nested } },
      ]) expect((await integrationToolReply(input, socketPath)).isError).toBe(true);
      expect(requestCount).toBe(0);
      for (let i = 0; i < replies.length; i++) {
        const result = await integrationToolReply(githubRead, socketPath);
        expect(result.isError).toBe(true);
        expect(text(result)).not.toContain("SECRET_");
        if (i === 0) expect(text(result)).toContain("did not grant access");
      }
      expect(requestCount).toBe(replies.length);
    });
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
