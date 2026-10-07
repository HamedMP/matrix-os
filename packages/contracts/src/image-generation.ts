import { z } from "zod/v4";
export const IMAGE_MODEL = "gemini-nano-banana-2.1";
export const IMAGE_MAX_BYTES = 16 * 1024 * 1024;
export const IMAGE_MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
export const ImageGenerationRequestSchema = z.object({
    requestId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/),
    prompt: z.string().trim().min(1).max(4000),
    model: z.literal(IMAGE_MODEL).default(IMAGE_MODEL),
    aspectRatio: z.enum(["1:1", "16:9", "9:16", "3:2", "2:3", "4:3", "3:4", "4:5", "5:4", "21:9"]).default("1:1"),
    imageSize: z.enum(["1K", "2K", "4K"]).default("1K"),
}).strict();
export type ImageGenerationRequest = z.output<typeof ImageGenerationRequestSchema>;
export const ImageGenerationResultSchema = z.object({
    model: z.literal(IMAGE_MODEL), mimeType: z.literal("image/png"),
    imageBase64: z.string().min(1).max(Math.ceil(IMAGE_MAX_BYTES / 3) * 4),
    costMicrousd: z.number().int().nonnegative().max(1000000),
}).strict();
export type ImageGenerationResult = z.output<typeof ImageGenerationResultSchema>;
export type ImageRuntimeIdentity = {
    ownerId: string;
    machineId: string;
    runtimeSlot: string;
    runtimeTokenEpoch: number;
};
export const IMAGE_RESERVATION_MICROUSD = 1000000;
