import { expect, it, vi } from "vitest";
import { createCanonicalShellChatClient } from "../../shell/src/lib/canonical-chat-client";
import { createCanonicalChatClient } from "../../desktop/src/renderer/src/lib/canonical-chat-client";
import { RoutineFullAccessStatusSchema } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

const { snapshot } = createCanonicalChatFixture("running");
const { activeRun, providerBinding, project, ...chat } = snapshot.chat;
const admission = { record: { chat, activeRun, providerBinding, projectId: project.projectId },
  message: snapshot.messages[0], turn: snapshot.turns[0], run: snapshot.runs[0], admission: "accepted" };
const input = { clientRequestId: "req_fixture_running", baseRevision: 0, parts: snapshot.messages[0]!.parts,
  selection: snapshot.runs[0]!.selection, interactionMode: "default", permissionMode: "full_access" };
const status = RoutineFullAccessStatusSchema.parse({ revision: 2, eligibility: "eligible", origin: "browser_required",
  challenge: null, consent: { scopeId: `rcfull_${"a".repeat(32)}`, expiresAt: new Date(Date.now() + 300_000).toISOString(),
    policyRevision: 1, actions: ["read", "propose", "control"], target: { botId: "bot_fixture1", chatId: "chat_destination" } } });

it("reads current server consent before a browser turn and sends only its nonsecret selector header", async () => {
  const fetchFn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async url => Response.json(url.includes("/routine-cli/full-access") ? status : admission));
  const client = createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn });
  await client.admitTurn(chat.id, input);
  expect(fetchFn.mock.calls[0]?.[0]).toContain(`/api/chats/${chat.id}/routine-cli/full-access`);
  const call = fetchFn.mock.calls.find(([, init]) => init?.method === "POST")!;
  const headers = new Headers(call[1]?.headers);
  expect(headers.get("x-matrix-routine-full-access-scope")).toBe(status.consent!.scopeId);
  expect(headers.has("x-matrix-routine-full-access-proof")).toBe(false);
  expect(JSON.parse(String(call[1]?.body))).toEqual(input);
});

it("does not reuse an earlier scope observation for another browser send", async () => {
  let reads = 0;
  const fetchFn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async url => Response.json(url.includes("/routine-cli/full-access")
    ? (++reads === 1 ? status : { ...status, revision: 3, consent: null }) : admission));
  const client = createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn });
  await client.admitTurn(chat.id, input);
  await client.admitTurn(chat.id, { ...input, clientRequestId: "req_fixture_next" });
  const posts = fetchFn.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
  expect(new Headers((posts[0]?.[1] as RequestInit)?.headers).get("x-matrix-routine-full-access-scope")).toBe(status.consent!.scopeId);
  expect(new Headers((posts[1]?.[1] as RequestInit)?.headers).has("x-matrix-routine-full-access-scope")).toBe(false);
  expect(reads).toBe(2);
});

it.each(["expired", "unavailable", "no consent"])("retains the exact-operation ceiling when browser scope is %s", async condition => {
  const current = condition === "expired" ? { ...status, consent: { ...status.consent!, expiresAt: "2000-01-01T00:00:00.000Z" } }
    : condition === "unavailable" ? { ...status, eligibility: "unavailable", consent: null } : { ...status, consent: null };
  const fetchFn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async url => Response.json(url.includes("/routine-cli/full-access") ? current : admission));
  await createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn }).admitTurn(chat.id, input);
  const post = fetchFn.mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(new Headers(post[1]?.headers).has("x-matrix-routine-full-access-scope")).toBe(false);
});

it("does not attach browser authority to device-authenticated Electron turns", async () => {
  const get = vi.fn(async () => status), post = vi.fn<(path: string, body: unknown, options?: unknown) => Promise<typeof admission>>(async () => admission);
  const client = createCanonicalChatClient({ get, post, patch: vi.fn(), delete: vi.fn() });
  await client.admitTurn(chat.id, input);
  const options = post.mock.calls[0]?.[2] as { headers?: Record<string, string> } | undefined;
  expect(options?.headers?.["x-matrix-routine-full-access-scope"]).toBeUndefined();
  expect(options?.headers?.["x-matrix-routine-full-access-proof"]).toBeUndefined();
  expect(get).not.toHaveBeenCalled();
});

it.each(["owner", "Computer", "Chat"])("does not post an old send after its captured %s changes during the status read", async change => {
  let release!: (value: typeof status) => void;
  const pending = new Promise<typeof status>(resolve => { release = resolve; });
  let epoch = "original";
  const fetchFn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async url => Response.json(url.includes("/routine-cli/full-access") ? await pending : admission));
  const client = createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn,
    captureAuthority: () => { const captured = epoch; return () => captured === epoch; } });
  const sending = client.admitTurn(chat.id, input);
  const rejected = expect(sending).rejects.toThrow("Chat context changed");
  await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
  epoch = change; release(status); await rejected;
  expect(fetchFn.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

it("treats a failed status read as no origin reference, preserving the separate exact-operation path", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const fetchFn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async url => url.includes("/routine-cli/full-access")
    ? Response.json({ error: "unavailable" }, { status: 503 }) : Response.json(admission));
  await createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn }).admitTurn(chat.id, input);
  const call = fetchFn.mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(new Headers(call[1]?.headers).has("x-matrix-routine-full-access-scope")).toBe(false);
  expect(warn).toHaveBeenCalled(); warn.mockRestore();
});
