import { z } from "zod/v4";

export const BROWSER_STREAM_PROTOCOL_VERSION = 1;
export const MAX_STREAM_MESSAGE_BYTES = 64 * 1024;
export const MAX_PENDING_INPUT = 128;
export const MAX_FALLBACK_FRAME_QUEUE = 3;

const surfaceSchema = z.enum(["canvas", "standalone"]);
const modifierSchema = z.enum(["Alt", "Control", "Meta", "Shift"]);

export const streamHelloSchema = z.object({
  type: z.literal("stream.hello"),
  payload: z.object({
    protocolVersion: z.number().int().positive(),
    surfaceId: z.string().min(1).max(128),
    surface: surfaceSchema,
    deviceId: z.string().min(1).max(128),
    viewport: z.object({
      width: z.number().int().min(1).max(3840),
      height: z.number().int().min(1).max(2160),
      deviceScaleFactor: z.number().min(0.5).max(4),
    }),
    media: z.object({
      preferredMode: z.enum(["webrtc", "fallback_frame"]),
      audio: z.boolean(),
      fallbackFrames: z.boolean(),
      iceTransportPolicy: z.literal("relay"),
    }),
  }),
});

export const pointerInputSchema = z.object({
  type: z.literal("input.pointer"),
  payload: z.object({
    kind: z.enum(["move", "down", "up", "wheel"]),
    x: z.number().min(0).max(3840),
    y: z.number().min(0).max(2160),
    button: z.enum(["left", "middle", "right", "none"]).default("none"),
    deltaX: z.number().min(-10000).max(10000).optional(),
    deltaY: z.number().min(-10000).max(10000).optional(),
    modifiers: z.array(modifierSchema).max(4).default([]),
  }),
});

export const keyboardInputSchema = z.object({
  type: z.literal("input.keyboard"),
  payload: z.object({
    kind: z.enum(["keydown", "keyup", "text"]),
    key: z.string().max(128),
    code: z.string().max(128),
    text: z.string().max(1024).default(""),
    modifiers: z.array(modifierSchema).max(4).default([]),
  }),
});

export const imeInputSchema = z.object({
  type: z.literal("input.ime"),
  payload: z.object({
    kind: z.enum(["compositionstart", "compositionupdate", "compositionend"]),
    text: z.string().max(2048),
  }),
});

export const pasteInputSchema = z.object({
  type: z.literal("input.paste"),
  payload: z.object({
    text: z.string().max(16 * 1024),
  }),
});

export const surfaceFocusSchema = z.object({
  type: z.literal("surface.focus"),
  payload: z.object({
    surfaceId: z.string().min(1).max(128),
    reason: z.enum(["pointer", "keyboard", "programmatic"]),
  }),
});

export const mediaAnswerSchema = z.object({
  type: z.literal("media.answer"),
  payload: z.object({
    sdp: z.string().min(1).max(64 * 1024),
  }),
});

export const mediaIceSchema = z.object({
  type: z.literal("media.ice"),
  payload: z.object({
    candidate: z.string().min(1).max(4096),
    sdpMid: z.string().max(64).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
  }),
});

export const browserNavigateSchema = z.object({
  type: z.literal("browser.navigate"),
  payload: z.object({
    targetUrl: z.string().min(1).max(2048),
    surface: surfaceSchema,
  }),
});

export const browserClientMessageSchema = z.discriminatedUnion("type", [
  streamHelloSchema,
  pointerInputSchema,
  keyboardInputSchema,
  imeInputSchema,
  pasteInputSchema,
  surfaceFocusSchema,
  mediaAnswerSchema,
  mediaIceSchema,
  browserNavigateSchema,
  z.object({
    type: z.literal("viewport.resize"),
    payload: streamHelloSchema.shape.payload.shape.viewport,
  }),
  z.object({
    type: z.literal("tab.focus"),
    payload: z.object({ tabId: z.string().min(1).max(128) }),
  }),
  z.object({
    type: z.literal("stream.ping"),
    payload: z.object({ lastFrameId: z.string().max(128).optional() }),
  }),
]);

export type BrowserClientMessage = z.infer<typeof browserClientMessageSchema>;

export function assertSupportedProtocolVersion(version: number): void {
  if (version !== BROWSER_STREAM_PROTOCOL_VERSION) {
    throw new Error("upgrade_required");
  }
}

export function parseBrowserClientMessage(value: unknown): BrowserClientMessage {
  const parsed = browserClientMessageSchema.parse(value);
  if (parsed.type === "stream.hello") {
    assertSupportedProtocolVersion(parsed.payload.protocolVersion);
  }
  return parsed;
}

export function assertBrowserMessageSize(raw: string | Buffer): void {
  const byteLength = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
  if (byteLength > MAX_STREAM_MESSAGE_BYTES) {
    throw new Error("message_too_large");
  }
}
