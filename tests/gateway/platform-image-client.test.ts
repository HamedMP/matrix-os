import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlatformImageClient } from "../../packages/gateway/src/image-generation/platform-client.js";
import { png } from "../helpers/image-generation-fixture.js";
const env = { MATRIX_PLATFORM_IMAGE_ENABLED: "true", MATRIX_PLATFORM_IMAGE_ORIGIN: "https://platform.example", MATRIX_PLATFORM_IMAGE_RUNTIME_TOKEN: "a".repeat(64), MATRIX_HANDLE: "images", MATRIX_RUNTIME_SLOT: "primary", MATRIX_MACHINE_ID: "machine_images", MATRIX_CLERK_USER_ID: "user_images" };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
describe("runtime platform image transport", () => {
    it("saves the validated PNG exactly and sends only its scoped credential", async () => {
        const dir = await mkdtemp(join(tmpdir(), "matrix-image-test-"));
        dirs.push(dir);
        const fetchFn = vi.fn(async () => Response.json({ model: "gemini-nano-banana-2.1", mimeType: "image/png", imageBase64: png, costMicrousd: 33615 }));
        const client = createPlatformImageClient(env, fetchFn)!;
        const result = await client.generateImage("An icon", { imageDir: dir, saveAs: "icon.png" });
        expect(await readFile(result.localPath)).toEqual(Buffer.from(png, "base64"));
        expect(result.cost).toBe(0.033615);
        const [url, init] = fetchFn.mock.calls[0] as unknown as [
            URL,
            RequestInit
        ];
        expect(url.toString()).toBe("https://platform.example/internal/containers/images/images?runtimeSlot=primary");
        expect(init.headers).toEqual({ authorization: `Bearer ${env.MATRIX_PLATFORM_IMAGE_RUNTIME_TOKEN}`, "content-type": "application/json" });
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.redirect).toBe("error");
        expect(JSON.parse(String(init.body))).toMatchObject({ model: "gemini-nano-banana-2.1", imageSize: "1K" });
    });
    it("rejects invalid requests before dispatch and never overwrites an existing file", async () => {
        const dir = await mkdtemp(join(tmpdir(), "matrix-image-test-"));
        dirs.push(dir);
        const fetchFn = vi.fn(async () => Response.json({ model: "gemini-nano-banana-2.1", mimeType: "image/png", imageBase64: png, costMicrousd: 33615 }));
        const client = createPlatformImageClient(env, fetchFn)!;
        await expect(client.generateImage("An icon", { imageDir: dir, saveAs: "../escape.png" })).rejects.toThrow();
        await expect(client.generateImage("An icon", { imageDir: dir, model: "gemini-2.5-flash-image" })).rejects.toThrow();
        expect(fetchFn).not.toHaveBeenCalled();
        await writeFile(join(dir, "kept.png"), "owner bytes");
        await expect(client.generateImage("An icon", { imageDir: dir, saveAs: "kept.png" })).rejects.toThrow();
        expect(await readFile(join(dir, "kept.png"), "utf8")).toBe("owner bytes");
        expect(fetchFn).not.toHaveBeenCalled();
    });
    it("fails closed for disabled or incomplete configuration and does not retry a rejected platform request", async () => {
        expect(createPlatformImageClient({})).toBeUndefined();
        expect(() => createPlatformImageClient({ ...env, MATRIX_PLATFORM_IMAGE_RUNTIME_TOKEN: undefined })).toThrow();
        expect(() => createPlatformImageClient({ ...env, MATRIX_PLATFORM_IMAGE_ORIGIN: "http://example.test" })).toThrow();
        const fetchFn = vi.fn(async () => new Response("upstream secret", { status: 503 }));
        await expect(createPlatformImageClient(env, fetchFn)!.generateImage("An icon", { imageDir: tmpdir() })).rejects.toThrow("Image generation is unavailable");
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });
});
