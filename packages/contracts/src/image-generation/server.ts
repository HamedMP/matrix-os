import { inflateSync } from "node:zlib";
import { z } from "zod/v4";
import { IMAGE_MAX_BYTES, IMAGE_MAX_RESPONSE_BYTES, IMAGE_MODEL, type ImageGenerationRequest, type ImageGenerationResult } from "../image-generation.js";
const Count = z.number().int().nonnegative().max(1000000);
const Modalities = z.array(z.object({ modality: z.enum(["text", "image"]), tokens: Count })).min(1).max(2);
const ZeroModality = z.array(z.object({ modality: z.enum(["text", "image"]), tokens: z.literal(0) })).max(2);
const Usage = z.object({
    total_input_tokens: Count, total_output_tokens: Count, total_thought_tokens: Count,
    total_cached_tokens: z.literal(0), total_tool_use_tokens: z.literal(0), total_tokens: Count,
    input_tokens_by_modality: Modalities, output_tokens_by_modality: Modalities,
    cached_tokens_by_modality: ZeroModality.optional(), tool_use_tokens_by_modality: ZeroModality.optional(),
    grounding_tool_counts: z.array(z.object({ type: z.enum(["google_search", "google_maps", "retrieval"]), count: z.literal(0) })).max(3).optional(),
}).strict();

const TextContent = z.object({ type: z.literal("text"), text: z.string().max(32000) });
const ImageContent = z.object({ type: z.literal("image"), mime_type: z.literal("image/png"), data: z.string().max(Math.ceil(IMAGE_MAX_BYTES / 3) * 4) });
const ModelOutput = z.object({ type: z.literal("model_output"), content: z.array(z.union([ImageContent, TextContent])).max(8) });
// Official ThoughtStep is a separate step, not an image content block.
const ThoughtImage = z.object({ type: z.literal("image"), mime_type: z.enum(["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif", "image/gif", "image/bmp", "image/tiff"]).optional(), data: z.string().max(Math.ceil(IMAGE_MAX_BYTES / 3) * 4).optional(), uri: z.string().max(2048).optional() });
const Thought = z.object({ type: z.literal("thought"), signature: z.string().max(8192).optional(), summary: z.array(z.union([TextContent, ThoughtImage])).max(8).optional() });
const ResponseSchema = z.object({ status: z.literal("completed"), steps: z.array(z.discriminatedUnion("type", [ModelOutput, Thought])).min(1).max(8), usage: Usage });

/** Server diagnostics use bounded, allowlisted metadata, never arbitrary messages,
 * stacks, causes, request bodies, credentials, or generated image contents. */
export function safeImageErrorDetails(error: unknown) {
    if (error instanceof z.ZodError) return { name: "ZodError", reason: "Image contract validation failed", issues: error.issues.slice(0, 8).map(issue => ({ code: issue.code, path: issue.path.slice(0, 8).map(part => typeof part === "number" ? part : ["steps", "content", "usage", "status", "data", "mime_type", "type", "total_input_tokens", "total_output_tokens", "total_thought_tokens", "total_tokens", "input_tokens_by_modality", "output_tokens_by_modality", "modality", "tokens", "imageBase64", "costMicrousd", "requestId"].includes(String(part)) ? part : "field") })) };
    const name = error instanceof Error && ["Error", "TypeError", "SyntaxError", "AbortError", "TimeoutError"].includes(error.name) ? error.name : "UnknownError";
    const message = error instanceof Error ? error.message : undefined;
    const reason = message && ["Invalid image response", "Invalid image bytes", "Unresolved image usage", "Image generation is unavailable", "Image service returned unsuccessful status", "Invalid image filename", "Invalid image filename.", "Image filename is already in use.", "fetch failed"].includes(message) ? message : name === "AbortError" || name === "TimeoutError" ? "Image request interrupted or timed out" : "Unexpected image failure";
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
    return { name, reason, ...(typeof code === "string" && ["ENOENT", "EEXIST", "EACCES", "ENOSPC", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "23503", "23505", "23514", "40001", "40P01", "08006"].includes(code) ? { code } : {}), ...(Number.isInteger(status) && Number(status) >= 400 && Number(status) <= 599 ? { upstreamStatus: status } : {}) };
}

export async function readBoundedImageJson(response: Response): Promise<unknown> {
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > IMAGE_MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new Error("Invalid image response");
    }
    if (!response.body)
        throw new Error("Invalid image response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done)
                break;
            size += next.value.byteLength;
            if (size > IMAGE_MAX_RESPONSE_BYTES || chunks.length >= 8192) {
                await reader.cancel();
                throw new Error("Invalid image response");
            }
            chunks.push(next.value);
        }
    }
    finally {
        reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
}
function crc(bytes: Uint8Array): number {
    let result = 0xffffffff;
    for (const byte of bytes) {
        result ^= byte;
        for (let i = 0; i < 8; i++)
            result = (result >>> 1) ^ ((result & 1) ? 0xedb88320 : 0);
    }
    return (result ^ 0xffffffff) >>> 0;
}
export function validateImagePng(base64: string): Buffer {
    // Length + canonical round-trip is linear and rejects all invalid padding/
    // alphabet variants without recursive regexp backtracking on large images.
    if (base64.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4 || base64.length % 4 !== 0)
        throw new Error("Invalid image bytes");
    const image = Buffer.from(base64, "base64");
    if (image.length < 45 || image.length > IMAGE_MAX_BYTES || image.toString("base64") !== base64 || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        throw new Error("Invalid image bytes");
    let offset = 8;
    let width = 0;
    let height = 0;
    let channels = 0;
    let ended = false;
    let idatEnded = false;
    let chunks = 0;
    const data: Buffer[] = [];
    while (offset < image.length) {
        if (offset + 12 > image.length)
            throw new Error("Invalid image bytes");
        const size = image.readUInt32BE(offset);
        if (size > IMAGE_MAX_BYTES || offset + size + 12 > image.length)
            throw new Error("Invalid image bytes");
        if (++chunks > 8192)
            throw new Error("Invalid image bytes");
        const type = image.toString("ascii", offset + 4, offset + 8);
        const body = image.subarray(offset + 8, offset + 8 + size);
        if (crc(image.subarray(offset + 4, offset + 8 + size)) !== image.readUInt32BE(offset + 8 + size))
            throw new Error("Invalid image bytes");
        if (!/^[A-Za-z]{4}$/.test(type) || (!new Set(["IHDR", "PLTE", "IDAT", "IEND"]).has(type) && type[0] === type[0]!.toUpperCase()))
            throw new Error("Invalid image bytes");
        if (data.length && type !== "IDAT")
            idatEnded = true;
        if (offset === 8 && type !== "IHDR")
            throw new Error("Invalid image bytes");
        if (type === "IHDR") {
            if (offset !== 8 || size !== 13)
                throw new Error("Invalid image bytes");
            width = body.readUInt32BE(0);
            height = body.readUInt32BE(4);
            channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[body[9]!] ?? 0;
            if (!width || !height || width > 8192 || height > 8192 || width * height > 20000000 || !channels || body[8] !== 8 || body[10] !== 0 || body[11] !== 0 || body[12] !== 0)
                throw new Error("Invalid image bytes");
        }
        else if (type === "IDAT") {
            if (idatEnded)
                throw new Error("Invalid image bytes");
            data.push(body);
        }
        else if (type === "IEND") {
            if (size !== 0 || offset + 12 !== image.length)
                throw new Error("Invalid image bytes");
            ended = true;
        }
        offset += size + 12;
    }
    if (!ended || data.length === 0)
        throw new Error("Invalid image bytes");
    const rowLength = width * channels + 1;
    const decoded = inflateSync(Buffer.concat(data), { maxOutputLength: rowLength * height });
    if (decoded.length !== rowLength * height)
        throw new Error("Invalid image bytes");
    for (let row = 0; row < height; row++)
        if (decoded[row * rowLength]! > 4)
            throw new Error("Invalid image bytes");
    return image;
}
export function parseInteractionImage(payload: unknown): ImageGenerationResult {
    const parsed = ResponseSchema.parse(payload);
    const images = parsed.steps.filter(step => step.type === "model_output").flatMap(step => step.content).filter(part => part.type === "image");
    if (images.length !== 1)
        throw new Error("Invalid image response");
    const image = images[0]!;
    validateImagePng(image.data);
    const u = parsed.usage;
    const sum = (rows: z.output<typeof Modalities>) => rows.reduce((total, row) => total + row.tokens, 0);
    if (new Set(u.input_tokens_by_modality.map(row => row.modality)).size !== u.input_tokens_by_modality.length || u.input_tokens_by_modality.some(row => row.modality !== "text") || new Set(u.output_tokens_by_modality.map(row => row.modality)).size !== u.output_tokens_by_modality.length || sum(u.input_tokens_by_modality) !== u.total_input_tokens || sum(u.output_tokens_by_modality) !== u.total_output_tokens || u.total_tokens !== u.total_input_tokens + u.total_output_tokens + u.total_thought_tokens)
        throw new Error("Unresolved image usage");
    const imageTokens = u.output_tokens_by_modality.find(row => row.modality === "image")?.tokens;
    if (!imageTokens)
        throw new Error("Unresolved image usage");
    const textTokens = (u.output_tokens_by_modality.find(row => row.modality === "text")?.tokens ?? 0) + u.total_thought_tokens;
    const cost = Math.ceil(u.total_input_tokens * 1.5 + textTokens * 7.5 + imageTokens * 30);
    if (cost > 1000000)
        throw new Error("Unresolved image usage");
    return { model: IMAGE_MODEL, mimeType: "image/png", imageBase64: image.data, costMicrousd: cost };
}
export async function generateInteractionImage(apiKey: string, input: ImageGenerationRequest, fetchFn: typeof fetch = fetch, shutdownSignal?: AbortSignal): Promise<ImageGenerationResult> {
    const response = await fetchFn("https://generativelanguage.googleapis.com/v1beta/interactions", { method: "POST", redirect: "error", signal: shutdownSignal ? AbortSignal.any([shutdownSignal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000), headers: { "x-goog-api-key": apiKey, "content-type": "application/json" }, body: JSON.stringify({ model: IMAGE_MODEL, input: [{ type: "text", text: input.prompt }], store: false, response_format: { type: "image", aspect_ratio: input.aspectRatio, image_size: input.imageSize, mime_type: "image/png" }, generation_config: { max_output_tokens: 8192 } }) });
    if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error("Image generation is unavailable"), { status: response.status });
    }
    return parseInteractionImage(await readBoundedImageJson(response));
}
