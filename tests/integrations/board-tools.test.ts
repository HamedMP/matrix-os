import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { createIntegrationsMcpServer } from "../../packages/integrations-mcp/src/server.js";
import type { GatewayFetcher } from "../../packages/kernel/src/tools/integrations.js";

afterEach(() => vi.unstubAllEnvs());

async function connect(fetcher: GatewayFetcher, toolSurface: "full" | "chat-call" = "full") {
  const server = createIntegrationsMcpServer({ fetcher, toolSurface });
  const client = new Client({ name: "board-fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const BOARD_TOOLS = ["board_read", "board_post", "board_reply", "board_label", "board_wait", "board_task_create", "board_task_claim", "board_task_renew", "board_task_settle"];

it("offers board tools to full owner agents only", async () => {
  const full = await connect(vi.fn());
  const chat = await connect(vi.fn(), "chat-call");
  try {
    expect((await full.client.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(BOARD_TOOLS));
    expect((await chat.client.listTools()).tools.map((tool) => tool.name).filter((name) => name.startsWith("board_"))).toEqual([]);
  } finally {
    await full.close();
    await chat.close();
  }
});

it("posts through the gateway with the pane identity header and a timeout", async () => {
  vi.stubEnv("MATRIX_AUTH_TOKEN", "synthetic");
  vi.stubEnv("ZELLIJ_SESSION_NAME", `matrix-w-${"a".repeat(32)}`);
  vi.stubEnv("ZELLIJ_PANE_ID", "7");
  const fetcher = vi.fn<GatewayFetcher>(async () => Response.json({ message: { id: "msg_abcdefgh1234" } }, { status: 201 }));
  const f = await connect(fetcher);
  try {
    const result = await f.client.callTool({ name: "board_post", arguments: { channel: "dev", text: "Found it", board: "Ops" } });
    expect(result.isError).not.toBe(true);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://localhost:4000/api/board/messages?board=Ops");
    expect(init).toMatchObject({ method: "POST", redirect: "error", signal: expect.any(AbortSignal) });
    expect(new Headers(init.headers).get("x-matrix-terminal-caller")).toBe(`matrix-w-${"a".repeat(32)}:7`);
    expect(JSON.parse(String(init.body))).toEqual({ channel: "dev", text: "Found it" });
  } finally {
    await f.close();
  }
});

it("maps settle outcomes to the task routes and surfaces only the reason on failure", async () => {
  const fetcher = vi.fn<GatewayFetcher>(async () => Response.json({ error: "x /private/path", reason: "claim_lost" }, { status: 409 }));
  const f = await connect(fetcher);
  try {
    const result = await f.client.callTool({ name: "board_task_settle", arguments: { id: "msg_abcdefgh1234", epoch: 2, token: "a".repeat(64), outcome: "block", text: "Need approval", kind: "needs_input" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("claim_lost");
    expect(JSON.stringify(result)).not.toContain("/private/path");
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://localhost:4000/api/board/tasks/msg_abcdefgh1234/block");
    expect(JSON.parse(String(init.body))).toEqual({ epoch: 2, token: "a".repeat(64), reason: "Need approval", kind: "needs_input" });
    expect((await f.client.callTool({ name: "board_task_claim", arguments: {} })).isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

// Fault detected (review): a valid long thread exceeded the response bound and could not be read at all.
it("reads a thread larger than the response bound as its newest replies with a count of those left out", async () => {
  const reply = (index: number) => ({ id: `msg_reply${String(index).padStart(6, "0")}`, text: "y".repeat(10_000) });
  const thread = { root: { id: "msg_rootroot1234", text: "Root" }, replies: Array.from({ length: 60 }, (_, index) => reply(index)), task: null };
  const f = await connect(vi.fn<GatewayFetcher>(async () => Response.json({ thread })));
  try {
    const result = await f.client.callTool({ name: "board_read", arguments: { target: "msg_rootroot1234" } });
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text.length).toBeLessThanOrEqual(256 * 1024);
    const parsed = JSON.parse(text) as { thread: { root: { text: string }; replies: Array<{ id: string }> }; omittedEarlierReplies: number };
    expect(parsed.thread.root.text).toBe("Root");
    expect(parsed.omittedEarlierReplies).toBeGreaterThan(0);
    expect(parsed.thread.replies.at(-1)!.id).toBe("msg_reply000059");
    expect(parsed.omittedEarlierReplies + parsed.thread.replies.length).toBe(60);
  } finally {
    await f.close();
  }
});

// Fault detected (review): a long fail reason passed the tool and then failed at the gateway, leaving the task claimed.
it("refuses a fail reason longer than the gateway accepts before calling it", async () => {
  const fetcher = vi.fn<GatewayFetcher>(async () => Response.json({}));
  const f = await connect(fetcher);
  try {
    const result = await f.client.callTool({ name: "board_task_settle", arguments: { id: "msg_rootroot1234", epoch: 1, token: "a".repeat(64), outcome: "fail", text: "z".repeat(3_000) } });
    expect(result.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    await f.client.callTool({ name: "board_task_settle", arguments: { id: "msg_rootroot1234", epoch: 1, token: "a".repeat(64), outcome: "complete", text: "z".repeat(3_000) } });
    expect(fetcher).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});
