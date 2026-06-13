"use strict";
const electron = require("electron");
const v4 = require("zod/v4");
const Empty = v4.z.object({}).strict();
const Ok = v4.z.object({ ok: v4.z.boolean() }).strict();
const ProfileSchema = v4.z.object({
  handle: v4.z.string().min(1).max(64),
  userId: v4.z.string().min(1).max(128)
}).strict();
const BoundsSchema = v4.z.object({
  x: v4.z.number().int().min(-16384).max(16384),
  y: v4.z.number().int().min(-16384).max(16384),
  width: v4.z.number().int().min(0).max(16384),
  height: v4.z.number().int().min(0).max(16384)
}).strict();
const STATE_KEYS = [
  "windowBounds",
  "lastProjectSlug",
  "panelLayouts",
  "appearance",
  "recents"
];
const MAX_STATE_VALUE_BYTES = 64 * 1024;
const BoundedJsonValue = v4.z.unknown().refine(
  (value) => {
    try {
      return JSON.stringify(value).length <= MAX_STATE_VALUE_BYTES;
    } catch {
      return false;
    }
  },
  { message: "state value too large" }
);
const INVOKE_CHANNELS = {
  "auth:start-device-flow": {
    request: Empty,
    response: v4.z.object({
      userCode: v4.z.string().min(1).max(32),
      verificationUri: v4.z.string().max(512),
      expiresIn: v4.z.number().int().positive()
    }).strict()
  },
  "auth:poll": {
    request: Empty,
    response: v4.z.object({
      status: v4.z.enum(["pending", "authorized", "expired"]),
      profile: ProfileSchema.optional()
    }).strict()
  },
  "auth:status": {
    request: Empty,
    response: v4.z.object({
      signedIn: v4.z.boolean(),
      handle: v4.z.string().max(64).optional(),
      runtimeSlot: v4.z.string().max(64),
      platformHost: v4.z.string().max(256)
    }).strict()
  },
  "auth:sign-out": { request: Empty, response: Ok },
  "runtime:select": {
    request: v4.z.object({ slot: v4.z.string().min(1).max(64) }).strict(),
    response: Ok
  },
  "state:get": {
    request: v4.z.object({ key: v4.z.enum(STATE_KEYS) }).strict(),
    response: v4.z.object({ value: v4.z.unknown() }).strict()
  },
  "state:set": {
    request: v4.z.object({ key: v4.z.enum(STATE_KEYS), value: BoundedJsonValue }).strict(),
    response: Ok
  },
  "embed:open": {
    request: v4.z.object({
      kind: v4.z.enum(["hosted-shell", "app"]),
      slug: v4.z.string().min(1).max(128).optional(),
      bounds: BoundsSchema
    }).strict(),
    response: v4.z.object({ embedId: v4.z.string().min(1).max(64) }).strict()
  },
  "embed:set-bounds": {
    request: v4.z.object({ embedId: v4.z.string().min(1).max(64), bounds: BoundsSchema }).strict(),
    response: Ok
  },
  "embed:close": {
    request: v4.z.object({ embedId: v4.z.string().min(1).max(64) }).strict(),
    response: Ok
  },
  "embed:retry-auth": {
    request: v4.z.object({ embedId: v4.z.string().min(1).max(64) }).strict(),
    response: Ok
  },
  notify: {
    request: v4.z.object({
      threadId: v4.z.string().min(1).max(128),
      title: v4.z.string().min(1).max(80),
      body: v4.z.string().max(200),
      kind: v4.z.enum(["done", "failed", "attention", "connection"])
    }).strict(),
    response: Ok
  },
  "badge:set": {
    request: v4.z.object({ count: v4.z.number().int().min(0).max(999) }).strict(),
    response: Ok
  },
  "shell:open-external": {
    request: v4.z.object({
      url: v4.z.string().max(2048).refine((value) => {
        try {
          return new URL(value).protocol === "https:";
        } catch {
          return false;
        }
      }, "https urls only")
    }).strict(),
    response: Ok
  },
  "update:check": {
    request: Empty,
    response: v4.z.object({ status: v4.z.enum(["disabled", "checking", "up-to-date", "downloading", "ready"]) }).strict()
  }
};
const EVENT_CHANNELS = {
  "auth:changed": v4.z.object({ signedIn: v4.z.boolean(), handle: v4.z.string().max(64).optional() }).strict(),
  "runtime:changed": v4.z.object({ slot: v4.z.string().min(1).max(64) }).strict(),
  "embed:state": v4.z.object({
    embedId: v4.z.string().min(1).max(64),
    state: v4.z.enum(["loading", "ready", "auth-required", "failed"])
  }).strict(),
  "notification:clicked": v4.z.object({ threadId: v4.z.string().min(1).max(128) }).strict(),
  "update:available": v4.z.object({ version: v4.z.string().max(64) }).strict(),
  "update:ready": v4.z.object({ version: v4.z.string().max(64) }).strict(),
  "window:focus-changed": v4.z.object({ focused: v4.z.boolean() }).strict()
};
const api = {
  invoke(channel, payload) {
    const entry = INVOKE_CHANNELS[channel];
    if (!entry) return Promise.reject(new Error("unknown channel"));
    const parsed = entry.request.safeParse(payload ?? {});
    if (!parsed.success) return Promise.reject(new Error("invalid request"));
    return electron.ipcRenderer.invoke(channel, parsed.data);
  },
  on(channel, callback) {
    const schema = EVENT_CHANNELS[channel];
    if (!schema) return () => void 0;
    const listener = (_event, payload) => {
      const parsed = schema.safeParse(payload);
      if (parsed.success) callback(parsed.data);
    };
    electron.ipcRenderer.on(channel, listener);
    return () => {
      electron.ipcRenderer.removeListener(channel, listener);
    };
  }
};
electron.contextBridge.exposeInMainWorld("operator", api);
