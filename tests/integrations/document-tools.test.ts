import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIntegrationsMcpServer, type IntegrationsMcpToolSurface } from "../../packages/integrations-mcp/src/server.js";
import { createOfficeDocumentRoutes } from "../../packages/gateway/src/office/routes.js";
import type { GatewayFetcher } from "../../packages/kernel/src/tools/integrations.js";

const OWNER_TOKEN = "owner-test-token";
const UNGATED = [
  "document_describe", "document_read_text", "document_propose_edits", "document_list_revisions",
  "document_add_comment", "document_compare", "document_create", "sheet_describe", "sheet_read_range",
  "sheet_propose_edits", "sheet_list_changes",
];
const APPROVAL = ["document_accept_revisions", "document_reject_revisions", "sheet_accept_changes", "sheet_reject_changes"];
const ALL = [...UNGATED, ...APPROVAL];

async function connect(fetcher: GatewayFetcher, surface: IntegrationsMcpToolSurface = "full") {
  const server = createIntegrationsMcpServer({ fetcher, toolSurface: surface });
  const client = new Client({ name: "document-tools-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function text(value: unknown): string {
  return (value as { content: Array<{ text: string }> }).content.map((item) => item.text).join("\n");
}

function payload(value: unknown): Record<string, unknown> {
  const raw = text(value);
  return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Record<string, unknown>;
}

describe("document tools on the integrations MCP surface", () => {
  beforeEach(() => { vi.stubEnv("MATRIX_AUTH_TOKEN", OWNER_TOKEN); vi.stubEnv("GATEWAY_URL", "http://127.0.0.1:4555"); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  // Fault detected: coding agents lack document tools, or can resolve proposals with no owner approval gate.
  it("advertises proposal tools on the full owner surface and never the resolution tools", async () => {
    const mcp = await connect(vi.fn());
    try {
      const tools = (await mcp.client.listTools()).tools;
      const names = tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(UNGATED));
      expect(names.filter((name) => APPROVAL.includes(name))).toEqual([]);
      expect(tools.find((tool) => tool.name === "document_propose_edits")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(tools.find((tool) => tool.name === "sheet_read_range")?.annotations).toMatchObject({ readOnlyHint: true });
    } finally { await mcp.close(); }
  });

  // Fault detected: scoped Run credentials or limited chat/custom surfaces reach owner documents.
  it("omits document tools on limited surfaces and with scoped credentials", async () => {
    for (const surface of ["chat-call", "chat-discovery", "custom-mcp-call", "jev-inbox-preview", "preview-drive-call"] as const) {
      const limited = await connect(vi.fn(), surface);
      try { expect((await limited.client.listTools()).tools.map((tool) => tool.name).filter((name) => ALL.includes(name))).toEqual([]); }
      finally { await limited.close(); }
    }
    vi.stubEnv("MATRIX_AGENT_INTEGRATIONS_TOKEN", "a".repeat(64));
    const scoped = await connect(vi.fn());
    try { expect((await scoped.client.listTools()).tools.map((tool) => tool.name).filter((name) => ALL.includes(name))).toEqual([]); }
    finally { await scoped.close(); }
  });

  // Fault detected: the MCP tool posts to the wrong gateway route, without owner auth, or follows redirects.
  it("posts the validated body to the matching gateway route with owner auth and a deadline", async () => {
    const fetcher = vi.fn<GatewayFetcher>(async () => new Response(JSON.stringify({
      path: "docs/q3.xlsx", version: "v1", saved: true, proposalId: "p1", changeIds: ["c1"], appliedEdits: [0], rejected: [],
    }), { status: 200 }));
    const mcp = await connect(fetcher);
    try {
      const result = await mcp.client.callTool({ name: "sheet_propose_edits", arguments: {
        path: "docs/q3.xlsx", label: "Fix total", edits: [{ op: "setCell", sheet: "Summary", cell: "B7", value: "=SUM(B2:B6)" }],
      } });
      expect(result.isError).toBeFalsy();
      expect(payload(result)).toMatchObject({ changeIds: ["c1"] });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [url, init] = fetcher.mock.calls[0]!;
      expect(url).toBe("http://127.0.0.1:4555/api/office/sheets/propose-edits");
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${OWNER_TOKEN}`);
      expect(JSON.parse(init.body as string)).toEqual({
        path: "docs/q3.xlsx", label: "Fix total", author: "Matrix OS",
        edits: [{ op: "setCell", sheet: "Summary", cell: "B7", value: "=SUM(B2:B6)" }],
      });
    } finally { await mcp.close(); }
  });

  // Fault detected: out-of-home or malformed input reaches the gateway from a coding agent.
  it("rejects malformed input before the gateway", async () => {
    const fetcher = vi.fn<GatewayFetcher>();
    const mcp = await connect(fetcher);
    try {
      for (const args of [{ path: "../../etc/passwd.docx" }, { path: "docs/a.docx", ownerId: "other" }, { path: "docs/a.pdf" }]) {
        expect(await mcp.client.callTool({ name: "document_describe", arguments: args })).toMatchObject({ isError: true });
      }
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await mcp.close(); }
  });

  describe("through the real document service", () => {
    let home: string;
    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), "document-mcp-"));
      await Promise.all([mkdir(join(home, "system")), mkdir(join(home, "docs"))]);
    });
    afterEach(async () => { await rm(home, { recursive: true, force: true }); });

    // Fault detected: a coding agent's edit is applied silently, or document text arrives unwrapped.
    it("creates a document and proposes a tracked revision the owner can review", async () => {
      const routes = createOfficeDocumentRoutes({ homePath: home });
      const fetcher: GatewayFetcher = async (url, init) =>
        routes.request(url.replace("http://127.0.0.1:4555/api/office", ""), init);
      const mcp = await connect(fetcher);
      try {
        await mcp.client.callTool({ name: "document_create", arguments: { path: "docs/nda.docx", paragraphs: ["Term: two years."] } });
        const described = await mcp.client.callTool({ name: "document_describe", arguments: { path: "docs/nda.docx" } });
        expect(text(described)).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
        const { blockIds, version } = payload(described) as { blockIds: string[]; version: string };
        const proposed = payload(await mcp.client.callTool({ name: "document_propose_edits", arguments: {
          path: "docs/nda.docx", ifVersion: version, edits: [{ op: "replaceText", blockId: blockIds[0], find: "two", replace: "three" }],
        } })) as { revisionIds: string[] };
        expect(proposed.revisionIds.length).toBeGreaterThan(0);
        const listed = payload(await mcp.client.callTool({ name: "document_list_revisions", arguments: { path: "docs/nda.docx" } })) as { total: number };
        expect(listed.total).toBeGreaterThan(0);
      } finally { await mcp.close(); }
    });
  });
});
