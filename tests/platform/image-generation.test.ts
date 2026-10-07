import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../packages/platform/src/main.js";
import { createDisabledOrchestrator } from "../../packages/platform/src/orchestrator.js";
import { createIpcServer } from "../../packages/kernel/src/ipc-server.js";
import type { MatrixDB } from "../../packages/kernel/src/db.js";
import * as imageModule from "../../packages/kernel/src/image-gen.js";
import * as usageModule from "../../packages/kernel/src/usage.js";
import { createPlatformImageClient } from "../../packages/gateway/src/image-generation/platform-client.js";
import { png, providerResponse } from "../helpers/image-generation-fixture.js";
import { sql } from "kysely";
import { Hono } from "hono";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createImageGenerationRoutes } from "../../packages/platform/src/image-generation/routes.js";
import { reconcilePlatformImageOperation } from "../../packages/platform/src/image-generation/reconcile.js";
import { createPlatformImageService } from "../../packages/platform/src/image-generation/service.js";
import { buildPlatformImageRuntimeVerificationToken, buildPlatformSpeechRuntimeVerificationToken } from "../../packages/platform/src/platform-token.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";
const sdk = vi.hoisted(() => ({
    createSdkMcpServer: vi.fn((config: unknown) => config),
    tool: vi.fn((name: string, _description: string, _schema: unknown, handler: unknown) => ({ name, handler })),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => sdk);
const secret = "image-platform-secret-12345678901234567890";
const identity = { ownerId: "user_images", machineId: "machine_images", runtimeSlot: "primary", runtimeTokenEpoch: 1 };
describe("platform funded image service", () => {
    let db: PlatformDB;
    beforeEach(async () => { ({ db } = await createTestPlatformDb()); await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: "images", runtimeSlot: "primary", provisioningClass: "customer", status: "running", imageVersion: "test", provisionedAt: "2026-10-07T12:00:00Z", activationState: "authorized" }); });
    afterEach(async () => { await destroyTestPlatformDb(db); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
    function setup(fetchFn = vi.fn(async () => new Response(JSON.stringify(providerResponse()))), cap = 1000000) {
        const service = createPlatformImageService({ db, config: { enabled: true, apiKey: "platform-only-key", monthlyAllowanceMicrousd: cap }, fetchFn, now: () => new Date("2026-10-07T12:00:00Z") });
        const app = new Hono();
        app.route("/internal/containers/:handle/images", createImageGenerationRoutes({ db, platformSecret: secret, service }));
        return { service, app, fetchFn };
    }
    const request = (id = "img_1") => ({ requestId: id, prompt: "An original Matrix icon", model: "gemini-nano-banana-2.1", aspectRatio: "1:1", imageSize: "1K" });
    const token = () => buildPlatformImageRuntimeVerificationToken({ handle: "images", machineId: identity.machineId, runtimeSlot: "primary" }, secret);
    it("uses Interactions with platform-only key and settles exact usage", async () => {
        const { service, fetchFn } = setup();
        const result = await service.generate(identity, request());
        expect(result.imageBase64).toBe(png);
        expect(result.costMicrousd).toBe(33615);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        const [url, opts] = fetchFn.mock.calls[0] as unknown as [
            string,
            RequestInit
        ];
        expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
        expect(JSON.parse(String(opts.body))).toMatchObject({ model: "gemini-nano-banana-2.1", store: false, response_format: { type: "image", mime_type: "image/png", image_size: "1K" } });
        const balance = await db.executor.selectFrom("image_monthly_allowances").selectAll().executeTakeFirstOrThrow();
        expect(Number(balance.spent_microusd)).toBe(33615);
        expect(Number(balance.reserved_microusd)).toBe(0);
    });
    it("does not redispatch a duplicate or silently retry uncertain provider usage", async () => {
        const { service, fetchFn } = setup(vi.fn(async () => new Response(JSON.stringify({ ...providerResponse(), usage: undefined }))));
        await expect(service.generate(identity, request())).rejects.toThrow();
        await expect(service.generate(identity, request())).rejects.toThrow();
        await expect(service.generate(identity, request("img_2"))).rejects.toThrow();
        expect(fetchFn).toHaveBeenCalledTimes(1);
        const op = await db.executor.selectFrom("image_generation_operations").selectAll().executeTakeFirstOrThrow();
        expect(op.state).toBe("uncertain");
    });
    it("rejects an insufficient allowance before provider dispatch", async () => {
        const { service, fetchFn } = setup(undefined, 1);
        await expect(service.generate(identity, request())).rejects.toThrow();
        expect(fetchFn).not.toHaveBeenCalled();
    });
    it("authenticates the runtime and rejects owner/legacy token substitution", async () => {
        const { app, fetchFn } = setup();
        const path = "/internal/containers/images/images?runtimeSlot=primary";
        expect((await app.request(path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fake" }, body: JSON.stringify(request()) })).status).toBe(401);
        expect((await app.request(path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token()}` }, body: JSON.stringify({ ...request(), ownerId: "user_other" }) })).status).toBe(400);
        expect(fetchFn).not.toHaveBeenCalled();
        expect((await app.request(path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token()}` }, body: JSON.stringify(request()) })).status).toBe(200);
    });
    it("preserves one owner/month allowance across requests and machine replacement", async () => {
        const { service, fetchFn } = setup(undefined, 2000000);
        await service.generate(identity, request());
        await db.executor.updateTable("user_machines").set({ status: "deleted", deleted_at: "2026-10-07T12:00:00Z" }).where("machine_id", "=", identity.machineId).execute();
        await insertUserMachine(db, { machineId: "replacement", clerkUserId: identity.ownerId, handle: "images-new", runtimeSlot: "primary", provisioningClass: "customer", status: "running", imageVersion: "test", provisionedAt: "2026-10-07T12:00:00Z", activationState: "authorized" });
        await service.generate({ ...identity, machineId: "replacement" }, request("img_2"));
        const balances = await db.executor.selectFrom("image_monthly_allowances").selectAll().execute();
        expect(balances).toHaveLength(1);
        expect(Number(balances[0]!.spent_microusd)).toBe(67230);
        expect(Number(balances[0]!.granted_microusd)).toBe(2000000);
        await expect(service.generate({ ...identity, machineId: "replacement" }, request())).rejects.toThrow();
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });
    it("admits only one concurrent funded dispatch per owner", async () => {
        let finish!: () => void;
        let started!: () => void;
        const barrier = new Promise<void>(resolve => { finish = resolve; });
        const dispatch = new Promise<void>(resolve => { started = resolve; });
        const { service, fetchFn } = setup(vi.fn(async () => { started(); await barrier; return Response.json(providerResponse()); }), 2000000);
        const first = service.generate(identity, request());
        await dispatch;
        await expect(service.generate(identity, request("img_2"))).rejects.toThrow();
        finish();
        await first;
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });
    it("does not renew an ambiguous hold at a month boundary and aborts pending work on shutdown", async () => {
        const service = createPlatformImageService({ db, config: { enabled: true, apiKey: "platform-only-key", monthlyAllowanceMicrousd: 2000000 }, fetchFn: vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); })), now: () => new Date("2026-10-31T23:59:59Z") });
        const operation = service.generate(identity, request());
        // Wait on the durable dispatch rather than a real provider or clock delay.
        for (let retry = 0; retry < 100; retry++) {
            if (await db.executor.selectFrom("image_generation_operations").select("request_id").executeTakeFirst())
                break;
            await new Promise(resolve => setTimeout(resolve, 1));
        }
        const failure = expect(operation).rejects.toThrow();
        await service.shutdown();
        await failure;
        const november = createPlatformImageService({ db, config: { enabled: true, apiKey: "platform-only-key", monthlyAllowanceMicrousd: 2000000 }, fetchFn: vi.fn(), now: () => new Date("2026-11-01T00:00:00Z") });
        await expect(november.generate(identity, request("img_2"))).rejects.toThrow();
        expect(await db.executor.selectFrom("image_monthly_allowances").selectAll().execute()).toHaveLength(1);
    });
    it("rejects an old epoch or speech credential, oversized input and ineligible machines before spending", async () => {
        const { app, service, fetchFn } = setup();
        const path = "/internal/containers/images/images?runtimeSlot=primary";
        const body = JSON.stringify(request());
        const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
        const speech = buildPlatformSpeechRuntimeVerificationToken({ handle: "images", machineId: identity.machineId, runtimeSlot: "primary" }, secret);
        expect((await app.request(path, { method: "POST", headers: headers(speech), body })).status).toBe(401);
        await db.executor.updateTable("user_machines").set({ runtime_token_epoch: 2 }).where("machine_id", "=", identity.machineId).execute();
        expect((await app.request(path, { method: "POST", headers: headers(token()), body })).status).toBe(401);
        const fresh = buildPlatformImageRuntimeVerificationToken({ handle: "images", machineId: identity.machineId, runtimeSlot: "primary" }, secret, 2);
        expect((await app.request(path, { method: "POST", headers: headers(fresh), body: "x".repeat(33000) })).status).toBe(413);
        await db.executor.updateTable("user_machines").set({ activation_state: "pending" }).where("machine_id", "=", identity.machineId).execute();
        await expect(service.generate(identity, request())).rejects.toThrow();
        expect(fetchFn).not.toHaveBeenCalled();
    });
    it("exercises generate_image IPC through runtime transport and platform settlement to exact owner PNG bytes", async () => {
        const { service, fetchFn } = setup();
        const app = createApp({ db, orchestrator: createDisabledOrchestrator({ db, image: "test" }), platformSecret: secret, env: {}, internalImageRuntimeRoutes: createImageGenerationRoutes({ db, platformSecret: secret, service }) });
        const dir = await mkdtemp(join(tmpdir(), "matrix-platform-image-chain-"));
        try {
            const transport: typeof fetch = async (url, init) => app.request(String(url), init);
            const client = createPlatformImageClient({ MATRIX_PLATFORM_IMAGE_ENABLED: "true", MATRIX_PLATFORM_IMAGE_ORIGIN: "https://platform.example", MATRIX_PLATFORM_IMAGE_RUNTIME_TOKEN: token(), MATRIX_HANDLE: "images", MATRIX_RUNTIME_SLOT: "primary", MATRIX_MACHINE_ID: identity.machineId, MATRIX_CLERK_USER_ID: identity.ownerId }, transport)!;
            await createIpcServer({} as MatrixDB, dir, undefined, undefined, client);
            const config = sdk.createSdkMcpServer.mock.calls.at(-1)![0] as {
                tools: Array<{
                    name: string;
                    handler: (input: unknown) => Promise<{
                        content: Array<{
                            text: string;
                        }>;
                    }>;
                }>;
            };
            const result = await config.tools.find(tool => tool.name === "generate_image")!.handler({ prompt: "Original illustration", save_as: "original.png" });
            expect(result.content[0]!.text).toContain("Platform-funded image generation");
            expect(await readFile(join(dir, "data", "images", "original.png"))).toEqual(Buffer.from(png, "base64"));
            expect(fetchFn).toHaveBeenCalledTimes(1);
            const op = await db.executor.selectFrom("image_generation_operations").selectAll().executeTakeFirstOrThrow();
            expect(op.owner_id).toBe(identity.ownerId);
            expect(op.state).toBe("succeeded");
        }
        finally {
            await rm(dir, { recursive: true, force: true });
            await app.shutdownPostHog();
        }
    });
    it("preserves explicit BYOK and never falls back to it after a funded failure", async () => {
        const dir = await mkdtemp(join(tmpdir(), "matrix-image-source-"));
        try {
            vi.stubEnv("GEMINI_API_KEY", "owner-key");
            const byok = vi.fn(async () => ({ localPath: "/test/byok.png", model: "gemini-2.5-flash-image", cost: 0.039 }));
            const create = vi.spyOn(imageModule, "createImageClient").mockReturnValue({ isConfigured: () => true, generateImage: byok });
            vi.spyOn(usageModule, "createUsageTracker").mockReturnValue({ track: vi.fn() } as unknown as ReturnType<typeof usageModule.createUsageTracker>);
            const platform = vi.fn(async () => { throw new Error("private provider failure"); });
            await createIpcServer({} as MatrixDB, dir, undefined, undefined, { isConfigured: () => true, generateImage: platform });
            const config = sdk.createSdkMcpServer.mock.calls.at(-1)![0] as {
                tools: Array<{
                    name: string;
                    handler: (input: unknown) => Promise<{
                        content: Array<{
                            text: string;
                        }>;
                    }>;
                }>;
            };
            const tool = config.tools.find(tool => tool.name === "generate_image")!;
            const failed = await tool.handler({ prompt: "Original illustration" });
            expect(failed.content[0]!.text).toBe("Image generation is unavailable. Try again later.");
            expect(create).not.toHaveBeenCalled();
            await tool.handler({ prompt: "Original illustration", funding_source: "byok" });
            expect(create).toHaveBeenCalledWith("owner-key");
            expect(byok).toHaveBeenCalledTimes(1);
            expect(platform).toHaveBeenCalledTimes(1);
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it.each([new Error("provider rejected /private/owner/image.png with token=secret"), "private validation detail"])("sanitizes registered Nano BYOK failures while logging their server details (%s)", async (failure) => {
        const dir = await mkdtemp(join(tmpdir(), "matrix-image-byok-error-"));
        try {
            vi.stubEnv("GEMINI_API_KEY", "owner-key");
            vi.spyOn(imageModule, "createImageClient").mockReturnValue({ isConfigured: () => true, generateImage: vi.fn(async () => { throw failure; }) });
            vi.spyOn(usageModule, "createUsageTracker").mockReturnValue({ track: vi.fn() } as unknown as ReturnType<typeof usageModule.createUsageTracker>);
            const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
            await createIpcServer({} as MatrixDB, dir);
            const config = sdk.createSdkMcpServer.mock.calls.at(-1)![0] as { tools: Array<{ name: string; handler: (input: unknown) => Promise<{ content: Array<{ text: string }> }> }> };
            const result = await config.tools.find(tool => tool.name === "generate_image")!.handler({ prompt: "Original illustration", model: "gemini-nano-banana-2.1", funding_source: "byok" });
            expect(result.content[0]!.text).toBe("Image generation is unavailable. Try again later.");
            expect(warning).toHaveBeenCalledWith("[ipc] BYOK image generation failed", failure);
        } finally { await rm(dir, { recursive: true, force: true }); }
    });
    it("reconciles an uncertain charge once using reviewed evidence without resetting spent", async () => {
        const { service } = setup(vi.fn(async () => Response.json({ ...providerResponse(), usage: undefined })), 2000000);
        await expect(service.generate(identity, request())).rejects.toThrow();
        const review = { ownerId: identity.ownerId, requestId: "img_1", actualMicrousd: 33615, evidenceReference: "billing-reviewed-123" };
        await reconcilePlatformImageOperation(db, review);
        await reconcilePlatformImageOperation(db, review);
        await expect(reconcilePlatformImageOperation(db, { ...review, actualMicrousd: 0 })).rejects.toThrow();
        const balance = await db.executor.selectFrom("image_monthly_allowances").selectAll().executeTakeFirstOrThrow();
        expect(Number(balance.reserved_microusd)).toBe(0);
        expect(Number(balance.spent_microusd)).toBe(33615);
        const op = await db.executor.selectFrom("image_generation_operations").selectAll().executeTakeFirstOrThrow();
        expect(op.reconciliation_evidence).toBe(review.evidenceReference);
    });
    it("rejects credentials rotated between HTTP authentication and atomic admission", async () => {
        const { app, service, fetchFn } = setup();
        const generate = service.generate;
        service.generate = async (who, input) => {
            await db.executor.updateTable("user_machines").set({ runtime_token_epoch: 2 }).where("machine_id", "=", identity.machineId).execute();
            return generate(who, input);
        };
        expect((await app.request("/internal/containers/images/images?runtimeSlot=primary", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token()}` }, body: JSON.stringify(request()) })).status).toBe(503);
        expect(fetchFn).not.toHaveBeenCalled();
    });
    it("admits other owners after an uncertain charge while retaining its financial hold", async () => {
        const { service } = setup(vi.fn(async () => Response.json({ ...providerResponse(), usage: undefined })), 2_000_000);
        await expect(service.generate(identity, request())).rejects.toThrow();
        const second = { ...identity, ownerId: "user_second", machineId: "machine_second" };
        await insertUserMachine(db, { machineId: second.machineId, clerkUserId: second.ownerId, handle: "images-second", runtimeSlot: "primary", provisioningClass: "customer", status: "running", imageVersion: "test", provisionedAt: "2026-10-07T12:00:00Z", activationState: "authorized" });
        await expect(service.generate(second, request("img_other"))).rejects.toThrow();
        const third = { ...identity, ownerId: "user_third", machineId: "machine_third" };
        await insertUserMachine(db, { machineId: third.machineId, clerkUserId: third.ownerId, handle: "images-third", runtimeSlot: "primary", provisioningClass: "customer", status: "running", imageVersion: "test", provisionedAt: "2026-10-07T12:00:00Z", activationState: "authorized" });
        const fetchFn = vi.fn(async () => Response.json(providerResponse()));
        const fresh = createPlatformImageService({ db, config: { enabled: true, apiKey: "platform-only-key", monthlyAllowanceMicrousd: 2_000_000 }, fetchFn, now: () => new Date("2026-10-07T12:00:00Z") });
        await fresh.generate(third, request("img_third")); expect(fetchFn).toHaveBeenCalledTimes(1);
        await expect(fresh.generate(identity, request("img_2"))).rejects.toThrow();
    });

    it("limits operations per month rather than permanently blocking a regular owner", async () => {
        const priorPeriod = "2026-09-01T00:00:00.000Z";
        await db.executor.insertInto("image_monthly_allowances").values({ owner_id: identity.ownerId, period_start: priorPeriod, granted_microusd: 2_000_000, spent_microusd: 0, reserved_microusd: 0 }).execute();
        await sql`INSERT INTO image_generation_operations (owner_id,request_id,machine_id,runtime_slot,period_start,payload_hash,state,reserved_microusd,actual_microusd,created_at,updated_at)
          SELECT ${identity.ownerId}, 'old_' || n::text, ${identity.machineId}, 'primary', ${priorPeriod}, ${"a".repeat(64)}, 'succeeded', 1000000, 0, ${priorPeriod}, ${priorPeriod} FROM generate_series(1,4096) n`.execute(db.executor);
        const { service, fetchFn } = setup(); await service.generate(identity, request()); expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("requires explicit BYOK with no platform dependency even when ambient or saved keys exist", async () => {
        const dir = await mkdtemp(join(tmpdir(), "matrix-image-explicit-source-"));
        try {
            const byok = vi.fn(async () => ({ localPath: "/test/byok.png", model: "gemini-2.5-flash-image", cost: 0.039 }));
            const create = vi.spyOn(imageModule, "createImageClient").mockReturnValue({ isConfigured: () => true, generateImage: byok });
            vi.spyOn(usageModule, "createUsageTracker").mockReturnValue({ track: vi.fn() } as unknown as ReturnType<typeof usageModule.createUsageTracker>);
            await mkdir(join(dir, "system")); await writeFile(join(dir, "system", "config.json"), JSON.stringify({ media: { gemini_api_key: "saved-owner-key" } }));
            vi.stubEnv("GEMINI_API_KEY", "ambient-owner-key");
            await createIpcServer({} as MatrixDB, dir);
            const config = sdk.createSdkMcpServer.mock.calls.at(-1)![0] as { tools: Array<{ name: string; handler: (input: unknown) => Promise<{ content: Array<{ text: string }> }> }> };
            const tool = config.tools.find(tool => tool.name === "generate_image")!;
            expect((await tool.handler({ prompt: "Original illustration" })).content[0]!.text).toBe("Image generation is unavailable.");
            vi.stubEnv("GEMINI_API_KEY", "");
            expect((await tool.handler({ prompt: "Original illustration" })).content[0]!.text).toBe("Image generation is unavailable.");
            expect(create).not.toHaveBeenCalled();
            await tool.handler({ prompt: "Original illustration", funding_source: "byok" });
            expect(create).toHaveBeenCalledWith("saved-owner-key"); expect(byok).toHaveBeenCalledTimes(1);
        } finally { await rm(dir, { recursive: true, force: true }); }
    });

});
