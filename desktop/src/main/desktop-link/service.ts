// The desktop side of the Desktop link (spec 2716). For each computer the person
// switched it on for, keep one outbound WebSocket to that computer's gateway,
// prove this device's device key on every connect, and pipe core streams the
// computer opens to this app's private herdr-core through the guard. Nothing
// listens on the desktop. Off by default; switching off closes the link at once.
import { sign, type KeyObject } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  DESKTOP_LINK_CLOSE, DESKTOP_LINK_CONTROL_MAX_BYTES, DESKTOP_LINK_PATH,
  DesktopLinkChallengeFrameSchema, DesktopLinkEnrolChallengeSchema, DesktopLinkEnrolmentSchema, DesktopLinkServerFrameSchema,
  desktopLinkEnrolProofMessage, desktopLinkProofMessage,
} from "@matrix-os/contracts/desktop-link";
import type { HcSocket } from "@matrix-os/herdr-core-client/client";
import { createDesktopLinkGuard, DesktopLinkGuardError, type DesktopLinkGuard } from "./guard";
import type { DesktopLinkPreferences, DesktopLinkPreferenceStore } from "./preferences";

export const DESKTOP_LINK_PING_MS = 15_000;
export const DESKTOP_LINK_STALE_MS = 45_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const HTTP_TIMEOUT_MS = 10_000;
/** The desktop stops reading from its core while the link has this much queued. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const SLOT = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type DesktopLinkState = "off" | "connecting" | "on" | "offline" | "removed" | "error";
export interface DesktopLinkStatus { slot: string; computerName: string; state: DesktopLinkState; terminalsFromComputer: number }

/** The subset of a WHATWG WebSocket the service uses (Node's global WebSocket in Electron main). */
export interface DesktopLinkSocket {
  binaryType: string;
  readonly bufferedAmount: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string | ArrayBufferView | ArrayBuffer): void;
  close(code?: number): void;
}

export interface DesktopLinkKey { privateKey: KeyObject; publicKey: string; deviceId: string }

export interface DesktopLinkServiceOptions {
  /** The platform origin the gateway is reached through (`https://app.matrix-os.com`). */
  gatewayOrigin(): string | null;
  /** The signed-in owner, or null when signed out. */
  ownerId(): string | null;
  /** A computer-scoped bearer for `slot`, or null. Never leaves main. */
  credential(slot: string): Promise<string | null>;
  keys: { loadOrCreate(scope: { ownerId: string; origin: string }, signal: AbortSignal): Promise<DesktopLinkKey> };
  /** A new raw stream to this app's private herdr-core. */
  openCore(): Promise<HcSocket>;
  preferences: DesktopLinkPreferenceStore;
  home: string;
  deviceName: string;
  app: { version: string; os: string };
  createSocket(url: string, headers: Record<string, string>): DesktopLinkSocket;
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  log?: (message: string) => void;
}

export class DesktopLinkEnableError extends Error {
  constructor(readonly reason: "signed_out" | "denied" | "too_many" | "unavailable") {
    super("could not let this computer use the desktop");
    this.name = "DesktopLinkEnableError";
  }
}

/**
 * One core stream. It exists from the moment the computer opens it, so bytes
 * the computer sends right behind `open` wait in `queue` for the core
 * connection instead of being lost.
 */
interface Stream { id: number; core: HcSocket | null; ended: boolean; guard: DesktopLinkGuard; queue: Promise<void> }

interface Link {
  slot: string;
  computerName: string;
  state: DesktopLinkState;
  terminals: number;
  socket: DesktopLinkSocket | null;
  admitted: boolean;
  lastSeen: number;
  failures: number;
  retry: ReturnType<typeof setTimeout> | null;
  stream: Stream | null;
}

function urlFor(origin: string, slot: string): string {
  const url = new URL(DESKTOP_LINK_PATH, origin);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  if (slot !== "primary") url.searchParams.set("runtime", slot);
  return url.toString();
}

function apiUrl(origin: string, slot: string, path: string): string {
  const url = new URL(`/api/desktop-link${path}`, origin);
  if (slot !== "primary") url.searchParams.set("runtime", slot);
  return url.toString();
}

function bytesOf(data: unknown): Buffer | null {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export function createDesktopLinkService(options: DesktopLinkServiceOptions) {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const fetcher = options.fetch ?? fetch;
  const log = options.log ?? ((message: string) => console.warn(`[desktop-link] ${message}`));
  const events = new EventEmitter();
  // One entry per computer the person switched on, capped by the preference store.
  const links = new Map<string, Link>();
  let prefs: DesktopLinkPreferences = { computers: {} };
  let disposed = false;
  const heartbeat = setInterval(() => sweep(), DESKTOP_LINK_PING_MS);
  heartbeat.unref?.();

  function status(link: Link): DesktopLinkStatus {
    return { slot: link.slot, computerName: link.computerName, state: link.state, terminalsFromComputer: link.terminals };
  }
  function changed(link: Link): void { events.emit("status", status(link)); }
  function setState(link: Link, state: DesktopLinkState): void {
    if (link.state === state) return;
    link.state = state;
    changed(link);
  }

  async function savePrefs(next: DesktopLinkPreferences): Promise<void> {
    prefs = next;
    await options.preferences.save(next);
  }

  function endStream(link: Link, tell: boolean): void {
    const stream = link.stream;
    if (!stream) return;
    link.stream = null;
    stream.ended = true;
    stream.core?.destroy();
    if (tell) sendText(link, { t: "end", stream: stream.id });
  }

  function sendText(link: Link, frame: Record<string, unknown>): void {
    try {
      link.socket?.send(JSON.stringify(frame));
    } catch (error: unknown) {
      log(`send failed: ${error instanceof Error ? error.name : "UnknownError"}`);
    }
  }

  /** Closes the WebSocket and everything piped through it. The guard stops forwarding first. */
  function hangUp(link: Link, code: number = DESKTOP_LINK_CLOSE.going): void {
    endStream(link, false);
    const socket = link.socket;
    link.socket = null;
    link.admitted = false;
    if (socket) {
      socket.onmessage = null;
      socket.onclose = null;
      try { socket.close(code); } catch (error: unknown) {
        log(`close failed: ${error instanceof Error ? error.name : "UnknownError"}`);
      }
    }
  }

  function scheduleRetry(link: Link, immediately = false): void {
    if (disposed || link.retry || !prefs.computers[link.slot]?.enabled) return;
    link.failures += 1;
    const wait = immediately ? 0 : Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** (link.failures - 1)) * (0.5 + random() / 2);
    link.retry = setTimeout(() => {
      link.retry = null;
      void dial(link);
    }, wait);
    link.retry.unref?.();
  }

  function openStream(link: Link, id: number): void {
    endStream(link, false);
    const stream: Stream = {
      id, core: null, ended: false,
      guard: createDesktopLinkGuard({ home: options.home, computerName: link.computerName }),
      queue: Promise.resolve(),
    };
    link.stream = stream;
    // Every earlier stream has stopped piping: tell the computer that what follows is this one's.
    sendText(link, { t: "opened", stream: id });
    stream.queue = options.openCore().then((core) => {
      if (stream.ended || link.stream !== stream || !link.socket) { core.destroy(); return; }
      stream.core = core;
      core.on("data", (chunk: Buffer) => {
        if (link.stream !== stream || !link.socket) return;
        if (link.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
          log("link fell behind; closing it");
          hangUp(link, DESKTOP_LINK_CLOSE.policy);
          scheduleRetry(link);
          return;
        }
        link.socket.send(chunk);
      });
      const ended = () => { if (link.stream === stream) endStream(link, true); };
      core.on("close", ended);
      core.on("error", ended);
    }, (error: unknown) => {
      log(`core unavailable: ${error instanceof Error ? error.name : "UnknownError"}`);
      if (link.stream === stream) endStream(link, true);
    });
  }

  /** Bytes from the computer for the current stream, through the guard, in order. */
  function fromComputer(link: Link, bytes: Buffer): void {
    const stream = link.stream;
    if (!stream) return;
    stream.queue = stream.queue.then(async () => {
      if (link.stream !== stream) return;
      // react-doctor-disable-next-line react-doctor/async-defer-await -- the check after this await is a different one: the stream may have been replaced or ended while the guard ran, and the guard must see every byte in order.
      const result = await stream.guard.push(bytes);
      if (link.stream !== stream || !stream.core) return;
      for (const out of result.toCore) stream.core.write(out);
      for (const answer of result.toComputer) link.socket?.send(answer);
    }).catch((error: unknown) => {
      if (!(error instanceof DesktopLinkGuardError)) log(`guard failed: ${error instanceof Error ? error.name : "UnknownError"}`);
      if (link.stream === stream) endStream(link, true);
    });
  }

  function onControl(link: Link, key: DesktopLinkKey, ownerId: string, text: string): void {
    if (Buffer.byteLength(text) > DESKTOP_LINK_CONTROL_MAX_BYTES) { hangUp(link, DESKTOP_LINK_CLOSE.policy); scheduleRetry(link); return; }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      hangUp(link, DESKTOP_LINK_CLOSE.policy);
      scheduleRetry(link);
      return;
    }
    if (!link.admitted) {
      // Before admission the gateway sends exactly a challenge, then `ready`.
      if (DesktopLinkServerFrameSchema.safeParse(raw).data?.t === "ready") {
        link.admitted = true;
        link.failures = 0;
        setState(link, "on");
        return;
      }
      const challenge = DesktopLinkChallengeFrameSchema.safeParse(raw);
      const saved = prefs.computers[link.slot];
      if (!challenge.success || !saved || challenge.data.machineId !== saved.machineId) {
        hangUp(link, DESKTOP_LINK_CLOSE.policy);
        setState(link, "error");
        return;
      }
      const signature = sign(null, Buffer.from(desktopLinkProofMessage({
        ownerId, machineId: saved.machineId, deviceId: key.deviceId, revision: saved.revision, nonce: challenge.data.nonce,
      })), key.privateKey).toString("base64url");
      sendText(link, { t: "proof", deviceId: key.deviceId, revision: saved.revision, signature, app: options.app });
      return;
    }
    const frame = DesktopLinkServerFrameSchema.safeParse(raw);
    if (!frame.success) { hangUp(link, DESKTOP_LINK_CLOSE.policy); scheduleRetry(link); return; }
    switch (frame.data.t) {
      case "ping": sendText(link, { t: "pong" }); return;
      case "pong": return;
      case "state": link.terminals = frame.data.terminalsFromComputer; changed(link); return;
      case "open": openStream(link, frame.data.stream); return;
      case "close": if (link.stream?.id === frame.data.stream) endStream(link, false); return;
      case "bye": return; // the close code that follows says what happened
      case "ready": return;
    }
  }

  async function dial(link: Link): Promise<void> {
    if (disposed || link.socket || !prefs.computers[link.slot]?.enabled) return;
    const origin = options.gatewayOrigin();
    const ownerId = options.ownerId();
    if (!origin || !ownerId) { setState(link, "offline"); return; }
    setState(link, link.state === "on" ? "offline" : "connecting");
    let key: DesktopLinkKey;
    let token: string | null;
    try {
      key = await options.keys.loadOrCreate({ ownerId, origin }, AbortSignal.timeout(HTTP_TIMEOUT_MS));
      token = await options.credential(link.slot);
    } catch (error: unknown) {
      log(`dial setup failed: ${error instanceof Error ? error.name : "UnknownError"}`);
      setState(link, "error");
      scheduleRetry(link);
      return;
    }
    if (!token) { setState(link, "offline"); scheduleRetry(link); return; }
    if (disposed || link.socket || !prefs.computers[link.slot]?.enabled) return;
    const socket = options.createSocket(urlFor(origin, link.slot), { Authorization: `Bearer ${token}` });
    socket.binaryType = "arraybuffer";
    link.socket = socket;
    link.admitted = false;
    link.lastSeen = now();
    socket.onmessage = (event) => {
      if (link.socket !== socket) return;
      link.lastSeen = now();
      if (typeof event.data === "string") { onControl(link, key, ownerId, event.data); return; }
      const bytes = bytesOf(event.data);
      if (!bytes || !link.admitted) { hangUp(link, DESKTOP_LINK_CLOSE.policy); scheduleRetry(link); return; }
      fromComputer(link, bytes);
    };
    socket.onclose = (event) => {
      if (link.socket !== socket) return;
      link.socket = null;
      link.admitted = false;
      endStream(link, false);
      void closedWith(link, event.code);
    };
    socket.onerror = () => { /* onclose follows with the code */ };
  }

  async function closedWith(link: Link, code: number): Promise<void> {
    if (code === DESKTOP_LINK_CLOSE.removed) {
      // Removed on the computer: never reconnect until the person switches it on again.
      setState(link, "removed");
      const saved = prefs.computers[link.slot];
      if (saved) await savePrefs({ computers: { ...prefs.computers, [link.slot]: { ...saved, enabled: false } } });
      return;
    }
    if (code === DESKTOP_LINK_CLOSE.auth) {
      // The enrolment no longer matches (another revision, or forgotten): the person must switch it on again.
      setState(link, "error");
      return;
    }
    if (code === DESKTOP_LINK_CLOSE.replaced) { setState(link, "offline"); return; }
    setState(link, "offline");
    scheduleRetry(link);
  }

  async function errorCode(response: Response): Promise<string | null> {
    try {
      const body = await response.json() as { error?: unknown };
      return typeof body?.error === "string" ? body.error : null;
    } catch (error: unknown) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  function sweep(): void {
    const at = now();
    for (const link of links.values()) {
      if (!link.socket || !link.admitted) continue;
      if (at - link.lastSeen > DESKTOP_LINK_STALE_MS) {
        hangUp(link);
        setState(link, "offline");
        scheduleRetry(link, true);
        continue;
      }
      sendText(link, { t: "ping" });
    }
  }

  function linkFor(slot: string, computerName: string): Link {
    let link = links.get(slot);
    if (!link) {
      link = { slot, computerName, state: "off", terminals: 0, socket: null, admitted: false, lastSeen: 0, failures: 0, retry: null, stream: null };
      links.set(slot, link);
    }
    link.computerName = computerName;
    return link;
  }

  async function postJson(url: string, token: string, body: unknown): Promise<Response> {
    return fetcher(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  }

  return {
    /** Loads saved choices and reconnects every computer that is switched on. */
    async start(): Promise<void> {
      prefs = await options.preferences.load();
      for (const [slot, saved] of Object.entries(prefs.computers)) {
        const link = linkFor(slot, saved.computerName);
        if (saved.enabled) void dial(link);
      }
    },

    statuses(): DesktopLinkStatus[] { return [...links.values()].map(status); },
    /** This device's device ids, from its enrolments (no key is read). */
    deviceIds(): string[] {
      return [...new Set(Object.values(prefs.computers).flatMap((saved) => (saved.deviceId ? [saved.deviceId] : [])))];
    },
    onStatus(listener: (status: DesktopLinkStatus) => void): () => void {
      events.on("status", listener);
      return () => { events.off("status", listener); };
    },

    /**
     * The person switched it on for one computer, after the confirmation.
     * Enrols this device's key there unless it already is, then connects.
     */
    async enable(slot: string, computerName: string): Promise<void> {
      if (!SLOT.test(slot)) throw new DesktopLinkEnableError("denied");
      const origin = options.gatewayOrigin();
      const ownerId = options.ownerId();
      if (!origin || !ownerId) throw new DesktopLinkEnableError("signed_out");
      const link = linkFor(slot, computerName.slice(0, 64));
      const saved = prefs.computers[slot];
      if (!saved || link.state === "removed" || link.state === "error") {
        const token = await options.credential(slot);
        if (!token) throw new DesktopLinkEnableError("unavailable");
        const key = await options.keys.loadOrCreate({ ownerId, origin }, AbortSignal.timeout(HTTP_TIMEOUT_MS));
        const challengeResponse = await postJson(apiUrl(origin, slot, "/enrol/challenge"), token, { deviceId: key.deviceId });
        if (!challengeResponse.ok) throw new DesktopLinkEnableError(challengeResponse.status === 403 ? "denied" : "unavailable");
        const challenge = DesktopLinkEnrolChallengeSchema.parse(await challengeResponse.json());
        const signature = sign(null, Buffer.from(desktopLinkEnrolProofMessage({
          ownerId, machineId: challenge.machineId, deviceId: key.deviceId, nonce: challenge.nonce,
        })), key.privateKey).toString("base64url");
        const enrolled = await postJson(apiUrl(origin, slot, "/enrol"), token, {
          nonce: challenge.nonce, publicKey: key.publicKey, signature, name: options.deviceName,
        });
        if (enrolled.status === 409 && await errorCode(enrolled) === "too_many") throw new DesktopLinkEnableError("too_many");
        if (!enrolled.ok && enrolled.status !== 409) throw new DesktopLinkEnableError(enrolled.status === 403 ? "denied" : "unavailable");
        if (enrolled.ok) {
          const enrolment = DesktopLinkEnrolmentSchema.parse(await enrolled.json());
          await savePrefs({ computers: { ...prefs.computers, [slot]: {
            enabled: true, computerName: link.computerName, machineId: enrolment.machineId, revision: enrolment.revision,
            deviceId: enrolment.deviceId,
          } } });
        } else if (saved) {
          // Already enrolled at the saved revision (a lost reply earlier): keep it.
          await savePrefs({ computers: { ...prefs.computers, [slot]: { ...saved, enabled: true } } });
        } else {
          throw new DesktopLinkEnableError("unavailable");
        }
      } else {
        await savePrefs({ computers: { ...prefs.computers, [slot]: { ...saved, enabled: true, computerName: link.computerName } } });
      }
      link.failures = 0;
      if (link.retry) { clearTimeout(link.retry); link.retry = null; }
      void dial(link);
    },

    /** The person switched it off: the link closes now, before the preference is written. */
    async disable(slot: string): Promise<void> {
      const link = links.get(slot);
      if (link) {
        if (link.retry) { clearTimeout(link.retry); link.retry = null; }
        sendText(link, { t: "bye", reason: "disabled" });
        hangUp(link);
        link.terminals = 0;
        setState(link, "off");
      }
      const saved = prefs.computers[slot];
      if (saved) await savePrefs({ computers: { ...prefs.computers, [slot]: { ...saved, enabled: false } } });
    },

    /** The app-menu kill switch: every computer is switched off at once. */
    async disableAll(): Promise<void> {
      await Promise.all([...links.keys()].map((slot) => this.disable(slot)));
    },

    /** Woke from sleep or the network came back: reconnect now instead of waiting out the backoff. */
    wake(): void {
      for (const link of links.values()) {
        if (link.socket && link.admitted) { sendText(link, { t: "ping" }); continue; }
        if (link.retry) { clearTimeout(link.retry); link.retry = null; }
        link.failures = 0;
        void dial(link);
      }
    },

    /** From the auth hook: signing out closes every link at once. Failures are logged here. */
    authChanged(signedIn: boolean): void {
      if (signedIn) return;
      this.signedOut().catch((error: unknown) => log(`sign-out cleanup failed: ${error instanceof Error ? error.name : "UnknownError"}`));
    },

    /** Signed out or the account changed: every link closes, choices are forgotten. */
    async signedOut(): Promise<void> {
      for (const link of links.values()) {
        if (link.retry) { clearTimeout(link.retry); link.retry = null; }
        sendText(link, { t: "bye", reason: "signed-out" });
        hangUp(link);
        setState(link, "off");
      }
      links.clear();
      await savePrefs({ computers: {} });
    },

    dispose(): void {
      disposed = true;
      clearInterval(heartbeat);
      for (const link of links.values()) {
        if (link.retry) clearTimeout(link.retry);
        sendText(link, { t: "bye", reason: "quit" });
        hangUp(link);
      }
      links.clear();
      events.removeAllListeners();
    },
  };
}

export type DesktopLinkService = ReturnType<typeof createDesktopLinkService>;
