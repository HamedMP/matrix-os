import { describe, expect, it } from "vitest";
import { ownerReadFixture, fiveRows, READ_TOOL, READ_PATH, MACHINE_SECRET, DATABASE_SECRET,
  OWNER, RUN, RUNTIME } from "../gateway/owner-app-data-read-fixture.js";

describe("ENG-289 registered owner app-data read MCP capability", () => {
  it.each(["chat-call", "chat-discovery"] as const)("advertises the dedicated read-only tool on %s", async surface => {
    const f = await ownerReadFixture();
    const { client } = await f.connectMcp(surface);
    const tools = (await client.listTools()).tools;
    const tool = tools.find(candidate => candidate.name === READ_TOOL);
    expect(tool, "Missing registered owner app-data read capability").toBeDefined();
    expect(tool!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool!.inputSchema).not.toHaveProperty("properties.sql");
  });

  it("roundtrips schema and five deterministic records through real MCP, bearer auth and PG", async () => {
    const f = await ownerReadFixture();
    const { client, fetcher } = await f.connectMcp();
    const schema = await client.callTool({ name: READ_TOOL, arguments: { action: "schema", app: "notes" } });
    expect(schema.isError).not.toBe(true);
    expect(JSON.stringify(schema.content)).toContain("entries");
    const result = await client.callTool({ name: READ_TOOL, arguments: fiveRows });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    const body = JSON.parse(content.filter(part => part.type === "text").map(part => part.text).join(""));
    expect(body.rows.map((row: { title: string }) => row.title)).toEqual(["note-1", "note-2", "note-3", "note-4", "note-5"]);
    expect(fetcher.mock.calls).toHaveLength(2);
    for (const [url, init] of fetcher.mock.calls) {
      expect(new URL(url).pathname).toBe(READ_PATH);
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${f.grant.token}` });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(JSON.stringify([result, schema, fetcher.mock.calls])).not.toContain(MACHINE_SECRET);
    expect(JSON.stringify([result, schema, fetcher.mock.calls])).not.toContain(DATABASE_SECRET);
    expect(JSON.stringify([result, schema])).not.toContain(f.grant.token);
    expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER.ownerId,
      runId: RUN, runtimeHandle: RUNTIME, action: "find", outcome: "allowed" }));
    expect(f.writes.every(spy => spy.mock.calls.length === 0)).toBe(true);
  });

  it("rejects SQL and mutations at the registered tool schema before transport", async () => {
    const f = await ownerReadFixture();
    const { client, fetcher } = await f.connectMcp();
    expect((await client.listTools()).tools.some(tool => tool.name === READ_TOOL)).toBe(true);
    for (const args of [{ action: "sql", sql: "SELECT 1" },
      { action: "insert", app: "notes", table: "entries", data: { title: "write" } }]) {
      expect((await client.callTool({ name: READ_TOOL, arguments: args })).isError).toBe(true);
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.raw).not.toHaveBeenCalled();
  });

  it("maps revocation to a generic tool error without returning credentials", async () => {
    const f = await ownerReadFixture();
    const { client, fetcher } = await f.connectMcp();
    expect((await client.listTools()).tools.some(tool => tool.name === READ_TOOL)).toBe(true);
    f.grant.revoke();
    const result = await client.callTool({ name: READ_TOOL, arguments: fiveRows });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("App data read unavailable");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(f.raw).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/Unauthorized|postgres:|db-secret|machine-secret/);
    expect(JSON.stringify(result)).not.toContain(f.grant.token);
  });
});
