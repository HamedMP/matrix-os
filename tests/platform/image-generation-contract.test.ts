import { describe, expect, it, vi } from "vitest";
import { ImageGenerationRequestSchema, IMAGE_MAX_RESPONSE_BYTES } from "../../packages/contracts/src/image-generation.js";
import { parseInteractionImage, readBoundedImageJson, validateImagePng, generateInteractionImage } from "../../packages/contracts/src/image-generation/server.js";
import { loadPlatformImageConfig } from "../../packages/platform/src/image-generation/config.js";
import { png, providerResponse, widePngFixture } from "../helpers/image-generation-fixture.js";
describe("bounded image provider contract", () => {
    it("accepts an 8MB valid PNG without a regex stack overflow", () => {
        expect(validateImagePng(widePngFixture(2048, 4096, 0)).length).toBeGreaterThan(8_000_000);
    });
    it("accepts the documented non-square 4K dimensions within a fixed pixel budget", () => {
        expect(validateImagePng(widePngFixture(5504, 3072)).length).toBeGreaterThan(45);
    });
    it("accepts documented thought steps while billing exact thinking usage", () => {
        const body = providerResponse();
        body.usage.total_thought_tokens = 10; body.usage.total_tokens += 10;
        expect(parseInteractionImage({ ...body, steps: [{ type: "thought", signature: "signed-thought", summary: [{ type: "text", text: "Composing the image" }] }, ...body.steps] }).costMicrousd).toBe(33690);
    });
    it("accepts bounded interim thought images but saves only final model output", () => {
        const body = providerResponse();
        const result = parseInteractionImage({ ...body, steps: [{ type: "thought", signature: "signed-thought", summary: [{ type: "image", mime_type: "image/jpeg", data: "ignored-interim-image" }, { type: "text", text: "Composing" }] }, ...body.steps] });
        expect(result.imageBase64).toBe(png); expect(result.costMicrousd).toBe(33615);
    });
    it("prices exact modality usage including separately reported thinking", () => {
        const body = providerResponse();
        body.usage.total_thought_tokens = 10;
        body.usage.total_tokens += 10;
        expect(parseInteractionImage(body).costMicrousd).toBe(33690);
    });
    it.each(["not png", png.slice(0, -3), Buffer.from("<svg/>").toString("base64"), png + "AAAA"])("rejects non-canonical or corrupt PNG bytes", value => {
        expect(() => validateImagePng(value)).toThrow();
    });
    it.each(["missing", "inconsistent", "cached", "tool", "duplicate", "overrun", "unknown"])("fails closed on %s usage", mode => {
        const body = providerResponse();
        if (mode === "missing")
            delete (body as {
                usage?: unknown;
            }).usage;
        if (mode === "inconsistent")
            body.usage.total_input_tokens++;
        if (mode === "cached")
            body.usage.total_cached_tokens++;
        if (mode === "tool")
            body.usage.total_tool_use_tokens++;
        if (mode === "duplicate")
            body.usage.output_tokens_by_modality.push({ modality: "image", tokens: 0 });
        if (mode === "overrun") {
            body.usage.output_tokens_by_modality[0]!.tokens = 40000;
            body.usage.total_output_tokens = 40000;
            body.usage.total_tokens = 40010;
        }
        if (mode === "unknown")
            body.usage.input_tokens_by_modality[0]!.modality = "audio";
        expect(() => parseInteractionImage(body)).toThrow();
    });
    it("fails closed for undeclared grounding charges", () => {
        const body = providerResponse();
        expect(() => parseInteractionImage({ ...body, usage: { ...body.usage, grounding_tool_counts: [{ type: "google_search", count: 2 }] } })).toThrow();
    });
    it("caps declared and streamed provider responses", async () => {
        await expect(readBoundedImageJson(new Response("{}", { headers: { "content-length": String(IMAGE_MAX_RESPONSE_BYTES + 1) } }))).rejects.toThrow();
        const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(IMAGE_MAX_RESPONSE_BYTES + 1)); controller.close(); } });
        await expect(readBoundedImageJson(new Response(oversized))).rejects.toThrow();
    });
    it("bounds request inputs and requires explicit operator activation", () => {
        expect(ImageGenerationRequestSchema.safeParse({ requestId: "image_1", prompt: "x".repeat(4001) }).success).toBe(false);
        expect(ImageGenerationRequestSchema.safeParse({ requestId: "image_1", prompt: "x", ownerId: "other" }).success).toBe(false);
        expect(loadPlatformImageConfig({})).toEqual({ enabled: false });
        expect(() => loadPlatformImageConfig({ PLATFORM_IMAGE_ENABLED: "true", PLATFORM_IMAGE_GEMINI_API_KEY: "a".repeat(32) })).toThrow();
        expect(() => loadPlatformImageConfig({ PLATFORM_IMAGE_ENABLED: "true", PLATFORM_IMAGE_GEMINI_API_KEY: "a".repeat(32), PLATFORM_IMAGE_MONTHLY_ALLOWANCE_MICROUSD: "100000001" })).toThrow();
    });
    it("never follows redirects or retries provider failures", async () => {
        const fetchFn = vi.fn(async () => new Response("private upstream reason", { status: 500 }));
        await expect(generateInteractionImage("platform-key", ImageGenerationRequestSchema.parse({ requestId: "image_1", prompt: "x" }), fetchFn)).rejects.toThrow("Image generation is unavailable");
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(fetchFn.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) })]));
    });
});
