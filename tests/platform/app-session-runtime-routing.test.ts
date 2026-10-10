import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { type PlatformDB, insertUserMachine } from "../../packages/platform/src/db.js";
import { createApp } from "../../packages/platform/src/main.js";
import { APP_SESSION_COOKIE, buildNativeAppSessionCookie } from "../../packages/platform/src/session-cookies.js";
import { resolveAppDomainIdentity } from "../../packages/platform/src/session-routing-identity.js";
import { SignJWT } from "jose";
import { issueSyncJwt, verifySyncJwt } from "../../packages/platform/src/sync-jwt.js";
import { CUSTOM_MCP_APPROVAL_PROOF_HEADER, verifyCustomMcpApprovalProof } from "../../packages/platform/src/custom-mcp-approval-proof.js";
import { PREVIEW_DRIVE_TURN_PROOF_HEADER, previewDriveTurnBodyDigest, verifyPreviewDriveTurnProof, mintPreviewDriveTurnProof } from '../../packages/platform/src/preview-drive-turn-proof.js';
import {
  JWT_SECRET,
  cleanupProxyRoutingTest,
  setupProxyRoutingTest,
  stubOrchestrator,
} from "./proxy-routing-test-utils.js";

async function insertMachine(
  db: PlatformDB,
  input: {
    clerkUserId?: string;
    handle: string;
    runtimeSlot: string;
    publicIPv4: string;
  },
): Promise<void> {
  await insertUserMachine(db, {
    machineId: `machine-${input.handle}`,
    clerkUserId: input.clerkUserId ?? "user_alice",
    handle: input.handle,
    runtimeSlot: input.runtimeSlot,
    status: "running",
    hetznerServerId: 100,
    publicIPv4: input.publicIPv4,
    imageVersion: "dev",
    serverType: "cpx22",
    provisionedAt: "2026-07-16T00:00:00.000Z",
  });
}

describe("browser app-session runtime routing", () => {
  let db: PlatformDB;

  beforeEach(async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    db = await setupProxyRoutingTest();
  });

  afterEach(async () => {
    await cleanupProxyRoutingTest(db);
    vi.unstubAllEnvs();
  });

  async function primarySessionCookie(): Promise<string> {
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: "alice-primary",
      gatewayUrl: "https://app.matrix-os.com/vm/alice-primary",
      runtimeSlot: "primary",
      sessionProvenance: "clerk-browser",
    });
    return `${APP_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
  }

  it("does not let another tab's route cookies move bare API calls off the signed app-session computer", async () => {
    await insertMachine(db, {
      handle: "alice-primary",
      runtimeSlot: "primary",
      publicIPv4: "203.0.113.20",
    });
    await insertMachine(db, {
      handle: "alice-review",
      runtimeSlot: "review",
      publicIPv4: "203.0.113.21",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("review", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue(null) }),
      platformSecret: "platform-secret-123",
    });

    const response = await app.request("/api/projects", {
      headers: {
        host: "app.matrix-os.com",
        cookie: [
          await primarySessionCookie(),
          "matrix_shell_route=alice-review",
          "matrix_shell_runtime_slot=review",
        ].join("; "),
      },
    });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.20:443/api/projects");
  });

  it("does not let a route cookie move an app session to another owner", async () => {
    await insertMachine(db, {
      handle: "alice-primary",
      runtimeSlot: "primary",
      publicIPv4: "203.0.113.20",
    });
    await insertMachine(db, {
      clerkUserId: "user_bob",
      handle: "bob-review",
      runtimeSlot: "review",
      publicIPv4: "203.0.113.22",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("primary", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue(null) }),
      platformSecret: "platform-secret-123",
    });

    const response = await app.request("/api/projects", {
      headers: {
        host: "app.matrix-os.com",
        cookie: [
          await primarySessionCookie(),
          "matrix_shell_route=bob-review",
          "matrix_shell_runtime_slot=review",
        ].join("; "),
      },
    });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.20:443/api/projects");
  });

  it("falls back to the signed app-session machine when the selected machine is missing", async () => {
    await insertMachine(db, {
      handle: "alice-primary",
      runtimeSlot: "primary",
      publicIPv4: "203.0.113.20",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("primary", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue(null) }),
      platformSecret: "platform-secret-123",
    });

    const response = await app.request("/api/projects", {
      headers: {
        host: "app.matrix-os.com",
        cookie: [
          await primarySessionCookie(),
          "matrix_shell_route=missing-review",
          "matrix_shell_runtime_slot=review",
        ].join("; "),
      },
    });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.20:443/api/projects");
  });

  it("keeps principal-only resolution independent from selected machine cookies", async () => {
    await insertMachine(db, {
      handle: "alice-review",
      runtimeSlot: "review",
      publicIPv4: "203.0.113.21",
    });
    const cookieHeader = [
      await primarySessionCookie(),
      "matrix_shell_route=alice-review",
      "matrix_shell_runtime_slot=review",
    ].join("; ");

    const identity = await resolveAppDomainIdentity({
      authHeader: undefined,
      cookieHeader,
      db,
      platformJwtSecret: JWT_SECRET,
      clerkPrincipalOnly: true,
      requestedHandle: "alice-review",
      runtimeSlot: "review",
    });

    expect(identity).toMatchObject({
      handle: "alice-primary",
      userId: "user_alice",
      runtimeSlot: "primary",
      source: "auth",
    });
  });

  it("attests the exact canonical approval through verified sync-JWT routing and overwrites caller proof", async () => {
    await insertMachine(db, { handle: "alice-primary", runtimeSlot: "primary", publicIPv4: "203.0.113.20" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("accepted", { status: 200 }));
    const app = createApp({ db, orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue(null) }), platformSecret: "platform-secret-123" });
    const path = "/api/chats/chat_1/runs/run_1/approvals/approval_1";
    const response = await app.request(path, { method: "POST", headers: {
      host: "app.matrix-os.com", cookie: await primarySessionCookie(), "content-type": "application/json",
      [CUSTOM_MCP_APPROVAL_PROOF_HEADER]: "forged",
    }, body: JSON.stringify({ clientRequestId: "req_1", decision: "approve" }) });
    expect(response.status).toBe(200);
    const forwarded = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    const proof = forwarded.get(CUSTOM_MCP_APPROVAL_PROOF_HEADER);
    expect(proof).not.toBe("forged");
    expect(verifyCustomMcpApprovalProof(proof ?? undefined, {
      handle: "alice-primary", actorId: "user_alice", chatId: "chat_1", runId: "run_1",
      approvalId: "approval_1", decision: "approve", clientRequestId: "req_1",
      secret: "platform-secret-123",
    })).toBe(true);
  });

  it("attests a verified Clerk request, and gives a generic machine bearer no proof", async () => {
    await insertMachine(db, { handle: "alice-primary", runtimeSlot: "primary", publicIPv4: "203.0.113.20" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("accepted", { status: 200 }));
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: "platform-secret-123",
      clerkAuth: createClerkAuth({ verifyToken: async token => {
        if (token !== "clerk-fixture") throw new Error("Invalid fixture token");
        return { sub: "user_alice" };
      } }) });
    const path = "/api/chats/chat_1/runs/run_1/approvals/approval_1";
    const body = JSON.stringify({ clientRequestId: "req_1", decision: "approve" });
    expect((await app.request(path, { method: "POST", headers: { host: "app.matrix-os.com",
      authorization: "Bearer clerk-fixture", "content-type": "application/json" }, body })).status).toBe(200);
    const forwarded = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    expect(verifyCustomMcpApprovalProof(forwarded.get(CUSTOM_MCP_APPROVAL_PROOF_HEADER) ?? undefined, {
      handle: "alice-primary", actorId: "user_alice", chatId: "chat_1", runId: "run_1",
      approvalId: "approval_1", decision: "approve", clientRequestId: "req_1", secret: "platform-secret-123",
    })).toBe(true);
    fetchMock.mockClear();
    const unauthenticated = await app.request(path, { method: "POST", headers: { host: "app.matrix-os.com",
      authorization: "Bearer platform-machine-bearer", "content-type": "application/json",
      [CUSTOM_MCP_APPROVAL_PROOF_HEADER]: "forged" }, body });
    expect(unauthenticated.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['explicit VM', 'app.matrix-os.com', '/vm/pr-1234/api/chats/chat_one/turns'],
    ['Preview host', 'pr-1234.preview.matrix-os.com', '/api/chats/chat_one/turns'],
  ])('rejects invalid UTF-8 on %s before attempting upstream forwarding', async (_route, host, path) => {
    vi.stubEnv('MATRIX_APP_DOMAIN_HOSTS', 'app.matrix-os.com,pr-1234.preview.matrix-os.com');
    await insertMachine(db, { handle: 'alice-primary', runtimeSlot: 'primary', publicIPv4: '203.0.113.20' });
    await insertUserMachine(db, { machineId: '00000000-0000-4000-8000-000000002045',
      clerkUserId: 'user_preview_owner', handle: 'pr-1234', runtimeSlot: 'pr-1234', provisioningClass: 'preview',
      accessClerkUserIds: ['user_alice'], status: 'running', publicIPv4: '203.0.113.45',
      provisionedAt: '2026-09-30T00:00:00.000Z' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('accepted', { status: 200 }));
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret-123',
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue(null) }) });
    const response = await app.request(path, { method: 'POST', headers: { host,
      cookie: await primarySessionCookie(), 'content-type': 'application/json' },
      body: new Uint8Array([0xc3, 0x28]) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Turn request unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mints a body-bound turn proof only for an authenticated direct Preview Claude turn', async () => {
    await insertMachine(db, { handle: 'alice-primary', runtimeSlot: 'primary', publicIPv4: '203.0.113.20' });
    await insertUserMachine(db, { machineId: '00000000-0000-4000-8000-000000002045',
      clerkUserId: 'user_preview_owner', handle: 'pr-1234', runtimeSlot: 'pr-1234', provisioningClass: 'preview',
      accessClerkUserIds: ['user_alice'], status: 'running', publicIPv4: '203.0.113.45',
      provisionedAt: '2026-09-30T00:00:00.000Z' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('accepted', { status: 200 }));
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret-123',
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue(null) }) });
    const body = { clientRequestId: 'req_one', baseRevision: 0, parts: [{ type: 'text', text: 'List my files' }],
      selection: { instanceId: 'claude_code_default', model: 'claude-sonnet-4-5' },
      interactionMode: 'default', permissionMode: 'supervised' };
    const path = '/vm/pr-1234/api/chats/chat_one/turns';
    const headers = { host: 'app.matrix-os.com', cookie: await primarySessionCookie(), 'content-type': 'application/json',
      [PREVIEW_DRIVE_TURN_PROOF_HEADER]: 'forged' };
    expect(await resolveAppDomainIdentity({ authHeader: undefined, cookieHeader: headers.cookie,
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue(null) }), db, platformJwtSecret: JWT_SECRET,
      requestedHandle: 'pr-1234', runtimeSlot: 'primary' })).toMatchObject({ userId: 'user_alice', handle: 'pr-1234' });
    expect((await app.request(path, { method: 'POST', headers, body: JSON.stringify(body) })).status).toBe(200);
    const forwarded = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    const proof = forwarded.get(PREVIEW_DRIVE_TURN_PROOF_HEADER);
    expect(proof).toBeTruthy();
    expect(proof).not.toBe('forged');
    expect(verifyPreviewDriveTurnProof(proof, { handle: 'pr-1234', actorId: 'user_alice', chatId: 'chat_one',
      clientRequestId: 'req_one', bodyDigest: previewDriveTurnBodyDigest(body), secret: 'platform-secret-123' })).toBeTruthy();
    expect(forwarded.get('cookie')).toBeNull();
    fetchMock.mockClear();
    expect((await app.request(path.replace('/turns', '/queued-turns'), { method: 'POST', headers,
      body: JSON.stringify(body) })).status).toBe(200);
    const queuedHeaders = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    expect(queuedHeaders.get(PREVIEW_DRIVE_TURN_PROOF_HEADER)).toBeNull();
  });
  it.each([
    ['clerk-device', 'bearer'], ['clerk-device', 'cookie'],
    ['clerk-browser', 'bearer'], ['clerk-browser', 'cookie'], ['clerk-device', 'code-cookie'], ['clerk-browser', 'code-cookie'],
    [undefined, 'bearer'], [undefined, 'cookie'], [undefined, 'code-cookie'], [undefined, 'ws'], [undefined, 'native-cookie'],
  ])('requires signed user provenance %s on %s for shared Preview turn and action', async (provenance, transport) => {
    vi.stubEnv('MATRIX_APP_DOMAIN_HOSTS', 'app.matrix-os.com,pr-1234.preview.matrix-os.com');
    await insertUserMachine(db, { machineId: '00000000-0000-4000-8000-000000002045',
      clerkUserId: 'user_preview_owner', handle: 'pr-1234', runtimeSlot: 'pr-1234', provisioningClass: 'preview',
      accessClerkUserIds: ['user_alice'], status: 'running', publicIPv4: '203.0.113.45',
      provisionedAt: '2026-09-30T00:00:00.000Z' });
    const token = await new SignJWT({ sub: 'user_alice', handle: 'pr-1234', runtime_slot: 'pr-1234',
      gateway_url: 'https://app.matrix-os.com/vm/pr-1234',
      ...(provenance ? { session_provenance: provenance } : {}) })
      .setProtectedHeader({ alg: 'HS256' }).setIssuer('matrix-os-platform').setAudience('matrix-os-sync')
      .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(JWT_SECRET));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('accepted', { status: 200 }));
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret-123',
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue(null) }) });
    const auth = transport === 'bearer' ? { authorization: `Bearer ${token}` }
      : transport === 'cookie' ? { cookie: `${APP_SESSION_COOKIE}=${token}` }
      : transport === 'native-cookie' ? { cookie: `${APP_SESSION_COOKIE}=${token}; ${buildNativeAppSessionCookie(token, JWT_SECRET).split(';')[0]}` }
      : transport === 'code-cookie' ? { cookie: `matrix_code_session=${token}` } : {};
    const turn = { clientRequestId: 'req_one', baseRevision: 0, parts: [{ type: 'text', text: 'List my files' }],
      selection: { instanceId: 'claude_code_default', model: 'claude-sonnet-4-5' },
      interactionMode: 'default', permissionMode: 'supervised' };
    for (const [host, prefix] of [['app.matrix-os.com', '/vm/pr-1234'], ['pr-1234.preview.matrix-os.com', '']]) {
      if (transport === 'ws') continue; // Query WS credentials are resolved separately below.
      for (const [suffix, body, proofHeader] of [
        ['/turns', turn, PREVIEW_DRIVE_TURN_PROOF_HEADER],
        ['/runs/run_one/approvals/approval_one', { clientRequestId: 'req_one', decision: 'approve', actionDigest: 'a'.repeat(64) }, CUSTOM_MCP_APPROVAL_PROOF_HEADER],
      ] as const) {
        fetchMock.mockClear();
        const response = await app.request(`${prefix}/api/chats/chat_one${suffix}`, { method: 'POST',
          headers: { host, ...auth, 'content-type': 'application/json', [proofHeader]: 'forged' }, body: JSON.stringify(body) });
        expect(response.status).toBe(200);
        const forwarded = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
        const proof = forwarded.get(proofHeader);
        expect(Boolean(proof)).toBe(Boolean(provenance));
        expect(proof).not.toBe('forged');
        if (provenance && suffix === '/turns') expect(verifyPreviewDriveTurnProof(proof, {
          handle: 'pr-1234', actorId: 'user_alice', chatId: 'chat_one', clientRequestId: 'req_one',
          bodyDigest: previewDriveTurnBodyDigest(turn), secret: 'platform-secret-123' })).toBeTruthy();
      }
    }
    const identity = await resolveAppDomainIdentity({ authHeader: transport === 'bearer' ? `Bearer ${token}` : undefined,
      cookieHeader: auth.cookie, wsToken: transport === 'ws' ? token : undefined,
      db, platformJwtSecret: JWT_SECRET, runtimeSlot: 'pr-1234' });
    expect(identity?.sessionProvenance).toBe(provenance);
    expect(Boolean(mintPreviewDriveTurnProof({ method: 'POST', path: '/api/chats/chat_one/turns',
      identity: identity!, body: JSON.stringify(turn), secret: 'platform-secret-123' }))).toBe(Boolean(provenance));
  });

  it('preserves generic cookie exchange without upgrading Preview authority; Clerk alone establishes browser provenance', async () => {
    await insertMachine(db, { handle: 'alice-primary', runtimeSlot: 'primary', publicIPv4: '203.0.113.20' });
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret-123',
      clerkAuth: createClerkAuth({ verifyToken: async token => token === 'clerk-fixture' ? { sub: 'user_alice' } : null }) });
    const generic = (await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: 'user_alice', handle: 'alice-primary',
      gatewayUrl: 'https://app.matrix-os.com/vm/alice-primary', runtimeSlot: 'primary' })).token;
    const exchange = (token: string) => app.request('/api/auth/app-session', { method: 'POST', headers: {
      host: 'app.matrix-os.com', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ redirectTo: '/' }) });
    const exchanged = await exchange(generic);
    expect(exchanged.status).toBe(200);
    const cookieHeader = exchanged.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const copied = /matrix_app_session=([^;]+)/.exec(cookieHeader)?.[1];
    expect(decodeURIComponent(copied!)).toBe(generic);
    expect((await verifySyncJwt(decodeURIComponent(copied!), { secret: JWT_SECRET })).session_provenance).toBeUndefined();
    expect(cookieHeader).toContain('matrix_native_app_session=');
    const genericIdentity = await resolveAppDomainIdentity({ authHeader: undefined, cookieHeader,
      db, platformJwtSecret: JWT_SECRET, runtimeSlot: 'primary' });
    expect(genericIdentity?.sessionProvenance).toBeUndefined();
    await insertUserMachine(db, { machineId: '00000000-0000-4000-8000-000000002045',
      clerkUserId: 'user_preview_owner', handle: 'pr-1234', runtimeSlot: 'pr-1234', provisioningClass: 'preview',
      accessClerkUserIds: ['user_alice'], status: 'running', publicIPv4: '203.0.113.45',
      provisionedAt: '2026-09-30T00:00:00.000Z' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('accepted', { status: 200 }));
    for (const [path, body, header] of [
      ['/turns', { clientRequestId: 'req_one', baseRevision: 0, parts: [{ type: 'text', text: 'List files' }],
        selection: { instanceId: 'claude_code_default', model: 'claude-sonnet-4-5' }, interactionMode: 'default', permissionMode: 'supervised' }, PREVIEW_DRIVE_TURN_PROOF_HEADER],
      ['/runs/run_one/approvals/approval_one', { clientRequestId: 'req_one', decision: 'approve', actionDigest: 'a'.repeat(64) }, CUSTOM_MCP_APPROVAL_PROOF_HEADER],
    ] as const) {
      fetchMock.mockClear();
      expect((await app.request(`/vm/pr-1234/api/chats/chat_one${path}`, { method: 'POST', headers: {
        host: 'app.matrix-os.com', cookie: cookieHeader, 'content-type': 'application/json', [header]: 'forged' }, body: JSON.stringify(body) })).status).toBe(200);
      expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get(header)).toBeNull();
    }
    const browser = await exchange('clerk-fixture');
    expect(browser.status).toBe(200);
    const identity = await resolveAppDomainIdentity({ authHeader: undefined,
      cookieHeader: browser.headers.get('set-cookie') ?? undefined, db, platformJwtSecret: JWT_SECRET, runtimeSlot: 'primary' });
    expect(identity?.sessionProvenance).toBe('clerk-browser');
  });

  it('carries a real Clerk-approved Electron device through runtime selection and both Preview proofs', async () => {
    vi.stubEnv('MATRIX_API_ORIGIN', 'https://api.matrix-os.com');
    await insertMachine(db, { handle: 'alice-primary', runtimeSlot: 'primary', publicIPv4: '203.0.113.20' });
    await insertUserMachine(db, { machineId: '00000000-0000-4000-8000-000000002045',
      clerkUserId: 'user_preview_owner', handle: 'pr-1234', runtimeSlot: 'pr-1234', provisioningClass: 'preview',
      accessClerkUserIds: ['user_alice'], status: 'running', publicIPv4: '203.0.113.45',
      provisionedAt: '2026-09-30T00:00:00.000Z' });
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret-123',
      clerkAuth: createClerkAuth({ verifyToken: async token => token === 'clerk-fixture' ? { sub: 'user_alice' } : null }) });
    const code = await (await app.request('/api/auth/device/code', { method: 'POST', headers: {
      'content-type': 'application/json' }, body: JSON.stringify({ clientId: 'matrix-os-desktop' }) })).json();
    const login = await app.request(`/auth/device?user_code=${code.userCode}`);
    const csrf = /device_csrf=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1];
    expect(csrf).toBeTruthy();
    expect((await app.request('/auth/device/approve', { method: 'POST', headers: {
      authorization: 'Bearer clerk-fixture', cookie: `device_csrf=${csrf}`,
      'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ userCode: code.userCode, csrf: csrf! }).toString() })).status).toBe(200);
    const polled = await app.request('/api/auth/device/token', { method: 'POST', headers: {
      'content-type': 'application/json' }, body: JSON.stringify({ deviceCode: code.deviceCode, clientId: 'matrix-os-desktop' }) });
    expect(polled.status).toBe(200);
    const device = await polled.json();
    expect((await verifySyncJwt(device.accessToken, { secret: JWT_SECRET })).session_provenance).toBe('clerk-device');
    const exchanged = await app.request('/api/auth/app-session', { method: 'POST', headers: {
      host: 'app.matrix-os.com', authorization: `Bearer ${device.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ redirectTo: '/' }) });
    expect(exchanged.status).toBe(200);
    expect(exchanged.headers.get('set-cookie')).toContain(encodeURIComponent(device.accessToken));
    const selected = await app.request('/api/auth/runtime-selection', { method: 'POST', headers: {
      host: 'api.matrix-os.com', authorization: `Bearer ${device.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ slot: 'pr-1234' }) });
    expect(selected.status).toBe(200);
    const token = (await selected.json()).accessToken;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('accepted', { status: 200 }));
    const turn = { clientRequestId: 'req_one', baseRevision: 0, parts: [{ type: 'text', text: 'List my files' }],
      selection: { instanceId: 'claude_code_default', model: 'claude-sonnet-4-5' }, interactionMode: 'default', permissionMode: 'supervised' };
    const headers = { host: 'app.matrix-os.com', authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    expect((await app.request('/vm/pr-1234/api/chats/chat_one/turns', { method: 'POST', headers, body: JSON.stringify(turn) })).status).toBe(200);
    const turnProof = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get(PREVIEW_DRIVE_TURN_PROOF_HEADER);
    expect(verifyPreviewDriveTurnProof(turnProof, { handle: 'pr-1234', actorId: 'user_alice', chatId: 'chat_one',
      clientRequestId: 'req_one', bodyDigest: previewDriveTurnBodyDigest(turn), secret: 'platform-secret-123' })).toBeTruthy();
    fetchMock.mockClear();
    expect((await app.request('/vm/pr-1234/api/chats/chat_one/runs/run_one/approvals/approval_one', { method: 'POST', headers,
      body: JSON.stringify({ clientRequestId: 'req_action', decision: 'approve', actionDigest: 'a'.repeat(64) }) })).status).toBe(200);
    const actionProof = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get(CUSTOM_MCP_APPROVAL_PROOF_HEADER);
    expect(verifyCustomMcpApprovalProof(actionProof ?? undefined, { handle: 'pr-1234', actorId: 'user_alice', chatId: 'chat_one',
      runId: 'run_one', approvalId: 'approval_one', decision: 'approve', clientRequestId: 'req_action', actionDigest: 'a'.repeat(64), secret: 'platform-secret-123' })).toBe(true);
  });

  it.each(['vps', 'legacy'])('preserves user provenance and expiry through %s code-cookie renewal', async runtime => {
    await insertMachine(db, { handle: 'alice-primary', runtimeSlot: 'primary', publicIPv4: '203.0.113.20' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('editor', { status: 200 }));
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret-123' });
    for (const sessionProvenance of ['clerk-device', 'clerk-browser', undefined] as const) {
      const issued = await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: 'user_alice',
        handle: runtime === 'vps' ? 'alice-primary' : 'alice', gatewayUrl: 'https://code.matrix-os.com', expiresInSec: 600, sessionProvenance });
      const response = await app.request('/', { headers: { host: 'code.matrix-os.com', authorization: `Bearer ${issued.token}` } });
      expect(response.status).toBe(200);
      const cookie = /matrix_code_session=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
      expect(cookie).toBeTruthy();
      const claims = await verifySyncJwt(decodeURIComponent(cookie!), { secret: JWT_SECRET });
      expect(claims.session_provenance).toBe(sessionProvenance);
      if (sessionProvenance) expect(claims.exp).toBeLessThanOrEqual(issued.claims.exp);
    }
  });

  it.each(['bearer', 'cookie'])('keeps ordinary owner approval semantics for unmarked %s sessions', async transport => {
    await insertMachine(db, { handle: 'alice-primary', runtimeSlot: 'primary', publicIPv4: '203.0.113.20' });
    const issued = await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: 'user_alice', handle: 'alice-primary', gatewayUrl: 'https://app.matrix-os.com' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('accepted', { status: 200 }));
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret-123' });
    const auth = transport === 'bearer' ? { authorization: `Bearer ${issued.token}` } : { cookie: `${APP_SESSION_COOKIE}=${issued.token}` };
    expect((await app.request('/api/chats/chat_one/runs/run_one/approvals/approval_one', { method: 'POST', headers: {
      host: 'app.matrix-os.com', ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ clientRequestId: 'req_one', decision: 'approve' }) })).status).toBe(200);
    const proof = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get(CUSTOM_MCP_APPROVAL_PROOF_HEADER);
    expect(verifyCustomMcpApprovalProof(proof ?? undefined, { handle: 'alice-primary', actorId: 'user_alice', chatId: 'chat_one',
      runId: 'run_one', approvalId: 'approval_one', clientRequestId: 'req_one', decision: 'approve', secret: 'platform-secret-123' })).toBe(true);
  });

  it.each(['bearer', 'cookie'])('keeps clock-tolerated expired %s user JWTs authenticated but gives them no Preview authority', async transport => {
    await insertMachine(db, { handle: 'alice-primary', runtimeSlot: 'primary', publicIPv4: '203.0.113.20' });
    const issued = await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: 'user_alice', handle: 'alice-primary',
      gatewayUrl: 'https://app.matrix-os.com', sessionProvenance: 'clerk-device',
      now: Math.floor(Date.now() / 1000) - 61, expiresInSec: 60 });
    const identity = await resolveAppDomainIdentity({ authHeader: transport === 'bearer' ? `Bearer ${issued.token}` : undefined,
      cookieHeader: transport === 'cookie' ? `${APP_SESSION_COOKIE}=${issued.token}` : undefined,
      db, platformJwtSecret: JWT_SECRET, runtimeSlot: 'primary' });
    expect(identity?.source).toBe('auth');
    expect(identity?.sessionProvenance).toBeUndefined();
    expect(mintPreviewDriveTurnProof({ method: 'POST', path: '/api/chats/chat_one/turns',
      identity: { ...identity!, handle: 'pr-1234' }, body: JSON.stringify({ clientRequestId: 'req_one', baseRevision: 0,
        parts: [{ type: 'text', text: 'List my files' }], selection: { instanceId: 'claude_code_default', model: 'claude-sonnet-4-5' },
        interactionMode: 'default', permissionMode: 'supervised' }), secret: 'platform-secret-123' })).toBeNull();
  });

});
