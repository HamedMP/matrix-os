import { randomUUID } from "node:crypto";
import { ImageGenerationRequestSchema, ImageGenerationResultSchema } from "@matrix-os/contracts";
import { readBoundedImageJson, validateImagePng } from "@matrix-os/contracts/image-generation/server";
import { saveGeneratedImage, assertImageDestinationAvailable, isSafeImageFileName, type ImageClient } from "@matrix-os/kernel";
export function createPlatformImageClient(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): ImageClient | undefined {
    if (env.MATRIX_PLATFORM_IMAGE_ENABLED !== "true" && env.MATRIX_PLATFORM_IMAGE_ENABLED !== "1")
        return undefined;
    const raw = env.MATRIX_PLATFORM_IMAGE_ORIGIN ?? env.PLATFORM_INTERNAL_URL;
    if (!raw || raw.length > 2048)
        throw new Error("Platform images are misconfigured");
    const origin = new URL(raw);
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(origin.hostname);
    if ((origin.protocol !== "https:" && !(loopback && origin.protocol === "http:")) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/")
        throw new Error("Platform images are misconfigured");
    const handle = env.MATRIX_HANDLE;
    const slot = env.MATRIX_RUNTIME_SLOT;
    const token = env.MATRIX_PLATFORM_IMAGE_RUNTIME_TOKEN;
    if (!handle || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(handle) || !slot || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(slot) || !token || !/^[a-f0-9]{64}$/.test(token) || !env.MATRIX_MACHINE_ID || !env.MATRIX_CLERK_USER_ID)
        throw new Error("Platform images are misconfigured");
    const url = new URL(`/internal/containers/${encodeURIComponent(handle)}/images`, origin);
    url.searchParams.set("runtimeSlot", slot);
    return { isConfigured: () => true, async generateImage(prompt, opts) {
            if (opts.saveAs && !isSafeImageFileName(opts.saveAs))
                throw new Error("Invalid image filename");
            const request = ImageGenerationRequestSchema.parse({ requestId: opts.requestId ?? `image_${randomUUID().replaceAll("-", "")}`, prompt, model: opts.model, aspectRatio: opts.aspectRatio, imageSize: opts.imageSize });
            await assertImageDestinationAvailable(opts);
            const response = await fetchFn(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(110000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(request) });
            if (!response.ok) {
                await response.body?.cancel();
                throw new Error("Image generation is unavailable");
            }
            const result = ImageGenerationResultSchema.parse(await readBoundedImageJson(response));
            const bytes = validateImagePng(result.imageBase64);
            const localPath = await saveGeneratedImage(bytes, prompt, opts);
            return { localPath, model: result.model, cost: result.costMicrousd / 1000000 };
        } };
}
