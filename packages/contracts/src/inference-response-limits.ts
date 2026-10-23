/** Raw provider response bytes, independent of prompts, files and display previews. */
export const INFERENCE_RESPONSE_BODY_MAX_BYTES = 1024 * 1024;

/** JSON may expand each control byte to six bytes; headers/envelope have their own headroom. */
export const INFERENCE_RESPONSE_FRAME_MAX_BYTES = 6 * INFERENCE_RESPONSE_BODY_MAX_BYTES + 4096;

/** Streaming bounds apply to one chunk or parser event, never the sum of a reply. */
export const INFERENCE_RESPONSE_CHUNK_MAX_BYTES = 64 * 1024;
export const INFERENCE_RESPONSE_BUFFER_MAX_BYTES = 1024 * 1024;
export const INFERENCE_RESPONSE_STREAM_FRAME_MAX_BYTES = 6 * INFERENCE_RESPONSE_CHUNK_MAX_BYTES + 4096;
