// The desktop side of the desktop link (spec 2716). While this device is paired
// with the primary computer (2698), keep one outbound WebSocket to that
// computer's gateway, prove the pairing key at the current pairing revision on
// every connect, and pipe core streams the computer opens to this app's private
// herdr-core through the guard. Nothing listens on the desktop. Stop closes the
// link at once and keeps the pairing.
import { sign } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  DESKTOP_LINK_CAPTURE_MAX_BYTES, DESKTOP_LINK_CAPTURE_PART_CHARS, DESKTOP_LINK_CLOSE, DESKTOP_LINK_CONTROL_MAX_BYTES, DESKTOP_LINK_PATH,
  DesktopLinkChallengeFrameSchema, DesktopLinkServerFrameSchema, desktopLinkProofMessage,
type DesktopLinkDeviceInfo,
} from "@matrix-os/contracts/desktop-link";
import type { HcSocket } from "@matrix-os/herdr-core-client/client";
import type { PairedLinkIdentity } from "../desktop-pairing";
import { createDesktopLinkConsent, type DesktopLinkConsent, type DesktopLinkConsentRequest } from "./consent";
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
export interface DesktopLinkStatus { slot: string; computerName: string; state: DesktopLinkState }

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


export interface DesktopLinkServiceOptions {
  /**
   * This device's 2698 pairing with the primary computer: its key, owner, origin
   * and current revision. Null when unpaired; throws when it cannot be read.
   */
  pairing: { linkIdentity(signal: AbortSignal): Promise<PairedLinkIdentity | null> };
  /** A computer-scoped bearer for `slot`, or null. Never leaves main. */
  credential(slot: string): Promise<string | null>;
  /**
   * The owner's consent on this desktop (D2): the native approval, and Full
   * Access for this desktop at the pairing the link proves.
   */
  consent: {
    ask(computerName: string, request: DesktopLinkConsentRequest, signal: AbortSignal): Promise<boolean>;
    fullAccess(identity: PairedLinkIdentity): Promise<boolean>;
  };
  /** A new raw stream to this app's private herdr-core. */
  openCore(): Promise<HcSocket>;
  preferences: DesktopLinkPreferenceStore;
  home: string;
  deviceName: string;
  app: { version: string; os: string };
  /** This desktop's OS, CPU and what it lets the computer do, reported on every connect. */
  device: DesktopLinkDeviceInfo;
  createSocket(url: string, headers: Record<string, string>): DesktopLinkSocket;
  /** One screenshot of this device's screen (JPEG), when the computer asks for one. */
  screenshot?(): Promise<DesktopScreenshotResult>;
  now?: () => number;
  random?: () => number;
  log?: (message: string) => void;
}

export type DesktopScreenshotResult = { ok: true; image: Buffer } | { ok: false; reason: "permission" | "unavailable" | "failed" | "too_large" };

export class DesktopLinkEnableError extends Error {
  constructor(readonly reason: "denied" | "not_paired" | "unavailable") {
    super("could not let this computer use the desktop");
    this.name = "DesktopLinkEnableError";
  }
}

/**
 * One core stream. It exists from the moment the computer opens it, so bytes
 * the computer sends right behind `open` wait in `queue` for the core
 * connection instead of being lost.
 */
interface Stream {
  id: number; core: HcSocket | null; ended: boolean; guard: DesktopLinkGuard; queue: Promise<void>;
  /** Bytes from the computer not yet through the guard (the core may still be opening). */
  queued: number;
}

/** Bytes from the computer one stream may hold before the guard takes them; more end the stream. */
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
/** A link not admitted this long after dialing is given up and dialed again (the gateway allows 10 s). */
const ADMISSION_DEADLINE_MS = 20_000;
/** Streams the computer may open per window; each one is a new connection to the core. */
const MAX_OPENS_PER_WINDOW = 10;
const OPEN_WINDOW_MS = 10_000;

interface Link {
  slot: string;
  computerName: string;
  state: DesktopLinkState;
  socket: DesktopLinkSocket | null;
  admitted: boolean;
  lastSeen: number;
  failures: number;
  /** When the computer opened its recent streams (rate limit). */
  opens: number[];
  retry: ReturnType<typeof setTimeout> | null;
  stream: Stream | null;
  /** The pairing this connection proves; read fresh on every dial. */
  identity: PairedLinkIdentity | null;
  /** What the owner allowed at that pairing; starts over on Stop, disconnect or a new revision. */
  consent: DesktopLinkConsent;
}

/** Only the primary computer pairs with a desktop (2698). */
const PRIMARY = "primary";

function urlFor(origin: string, slot: string): string {
  const url = new URL(DESKTOP_LINK_PATH, origin);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
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
  const log = options.log ?? ((message: string) => console.warn(`[desktop-link] ${message}`));
  const events = new EventEmitter();
  // One entry per computer the person switched on, capped by the preference store.
  const links = new Map<string, Link>();
  let prefs: DesktopLinkPreferences = { computers: {} };
  // Slots with a screenshot being taken; bounded by the links themselves.
  const capturingLinks = new Set<string>();
  let disposed = false;
  // Who was signed in when last told: undefined before the first auth notice.
  let signedInAs: string | null | undefined;
  // Counts Stops and sign-outs, so an enable that was still reading the pairing cannot undo one.
  let stops = 0;
  const heartbeat = setInterval(() => sweep(), DESKTOP_LINK_PING_MS);
  heartbeat.unref?.();

  function status(link: Link): DesktopLinkStatus {
    return { slot: link.slot, computerName: link.computerName, state: link.state };
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
    // Approvals this stream asked for close; an Allow given after it ended counts as no.
    stream.guard.close();
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
      // A browser-style WebSocket closes only with 1000 or 3000-4999; others throw and leave it open.
      const sendable = code === 1000 || (code >= 3000 && code <= 4999) ? code : code === DESKTOP_LINK_CLOSE.policy ? 4008 : 1000;
      try { socket.close(sendable); } catch (error: unknown) {
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
      guard: createDesktopLinkGuard({ home: options.home, computerName: link.computerName, consent: link.consent, platform: process.platform }),
      queue: Promise.resolve(), queued: 0,
    };
    link.stream = stream;
    // Every earlier stream has stopped piping: tell the computer that what follows is this one's.
    sendText(link, { t: "opened", stream: id });
    stream.queue = options.openCore().then((core) => {
      if (stream.ended || link.stream !== stream || !link.socket) { core.destroy(); return; }
      stream.core = core;
      // The guard alone writes to the core: its own handshake first, then only what it rebuilt.
      stream.guard.connect((bytes) => { if (!stream.ended && link.stream === stream) core.write(bytes); });
      core.on("data", (chunk: Buffer) => {
        if (link.stream !== stream || !link.socket) return;
        if (link.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
          log("link fell behind; closing it");
          hangUp(link, DESKTOP_LINK_CLOSE.policy);
          scheduleRetry(link);
          return;
        }
        let out: Buffer[];
        try {
          out = stream.guard.fromCore(chunk);
        } catch (error: unknown) {
          // The core's answers can no longer be matched to calls: end this stream (a new one starts clean).
          log(`core reply not read: ${error instanceof Error ? error.name : "UnknownError"}`);
          endStream(link, true);
          return;
        }
        for (const bytes of out) link.socket.send(bytes);
      });
      const ended = () => { if (link.stream === stream) endStream(link, true); };
      core.on("close", ended);
      core.on("error", ended);
    }, (error: unknown) => {
      log(`core unavailable: ${error instanceof Error ? error.name : "UnknownError"}`);
      if (link.stream === stream) endStream(link, true);
    });
  }

  /**
   * One screenshot for the computer, sent back in pieces. At most one at a
   * time per link; a second request while one runs is refused.
   */
  async function capture(link: Link, id: string): Promise<void> {
    const socket = link.socket;
    if (!socket || capturingLinks.has(link.slot)) { sendText(link, { t: "capture-failed", id, reason: "failed" }); return; }
    capturingLinks.add(link.slot);
    try {
      if (!(await link.consent.screenshot())) {
        if (link.socket === socket) sendText(link, { t: "capture-failed", id, reason: "declined" });
        return;
      }
      if (link.socket !== socket) return;
      const result = options.screenshot ? await options.screenshot() : { ok: false as const, reason: "failed" as const };
      if (link.socket !== socket) return;
      if (!result.ok) { sendText(link, { t: "capture-failed", id, reason: result.reason }); return; }
      if (result.image.length > DESKTOP_LINK_CAPTURE_MAX_BYTES) { sendText(link, { t: "capture-failed", id, reason: "too_large" }); return; }
      const data = result.image.toString("base64");
      const parts = Math.max(1, Math.ceil(data.length / DESKTOP_LINK_CAPTURE_PART_CHARS));
      for (let index = 0; index < parts; index += 1) {
        if (link.socket !== socket) return;
        sendText(link, {
          t: "capture-part", id, index, last: index === parts - 1,
          data: data.slice(index * DESKTOP_LINK_CAPTURE_PART_CHARS, (index + 1) * DESKTOP_LINK_CAPTURE_PART_CHARS),
        });
      }
    } catch (error: unknown) {
      log(`screenshot failed: ${error instanceof Error ? error.name : "UnknownError"}`);
      sendText(link, { t: "capture-failed", id, reason: "failed" });
    } finally {
      capturingLinks.delete(link.slot);
    }
  }

  /** Bytes from the computer for the current stream, through the guard, in order. */
  function fromComputer(link: Link, bytes: Buffer): void {
    const stream = link.stream;
    if (!stream) return;
    stream.queued += bytes.length;
    if (stream.queued > MAX_QUEUED_BYTES) {
      log("computer sent more than the stream holds; ending it");
      endStream(link, true);
      return;
    }
    stream.queue = stream.queue.then(async () => {
      stream.queued -= bytes.length;
      if (link.stream !== stream || !stream.core) return;
      // The guard writes what it lets through to the core itself; only answers come back here.
      // react-doctor-disable-next-line react-doctor/async-defer-await -- the check after this await is a different one: the stream may have been replaced or ended while the guard ran, and the guard must see every byte in order.
      const result = await stream.guard.push(bytes);
      if (link.stream !== stream) return;
      for (const answer of result.toComputer) link.socket?.send(answer);
      // Calls waiting for the owner land when the owner answers, without holding up the stream.
      for (const later of result.deferred ?? []) {
        later.then((decided) => {
          if (link.stream !== stream || stream.ended) return;
          for (const answer of decided.toComputer) link.socket?.send(answer);
        }, (error: unknown) => {
          log(`guard failed: ${error instanceof Error ? error.name : "UnknownError"}`);
          if (link.stream === stream) endStream(link, true);
        });
      }
    }).catch((error: unknown) => {
      if (link.stream !== stream) return;
      if (error instanceof DesktopLinkGuardError && error.reason === "channel") {
        // Bytes for a terminal the computer was never given: the whole link closes.
        log("computer wrote to a channel it was not given; closing the link");
        hangUp(link, DESKTOP_LINK_CLOSE.policy);
        scheduleRetry(link);
        return;
      }
      if (!(error instanceof DesktopLinkGuardError)) log(`guard failed: ${error instanceof Error ? error.name : "UnknownError"}`);
      endStream(link, true);
    });
  }

  function onControl(link: Link, identity: PairedLinkIdentity, text: string): void {
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
      if (!challenge.success || challenge.data.machineId !== identity.machineId) {
        hangUp(link, DESKTOP_LINK_CLOSE.policy);
        setState(link, "error");
        return;
      }
      const { ownerId, machineId, deviceId, revision } = identity;
      const signature = sign(null, Buffer.from(desktopLinkProofMessage({
        ownerId, machineId, deviceId, revision, nonce: challenge.data.nonce,
      })), identity.privateKey).toString("base64url");
      sendText(link, {
        t: "proof", name: options.deviceName, deviceId, revision, signature, app: options.app, device: options.device,
      });
      return;
    }
    const frame = DesktopLinkServerFrameSchema.safeParse(raw);
    if (!frame.success) { hangUp(link, DESKTOP_LINK_CLOSE.policy); scheduleRetry(link); return; }
    switch (frame.data.t) {
      case "ping": sendText(link, { t: "pong" }); return;
      case "pong": return;
      case "open": {
        // Each stream is a new connection to the core: at most a few a second.
        const at = now();
        link.opens = link.opens.filter((opened) => at - opened < OPEN_WINDOW_MS);
        if (link.opens.length >= MAX_OPENS_PER_WINDOW) {
          log("computer opened streams too fast; closing the link");
          hangUp(link, DESKTOP_LINK_CLOSE.policy);
          scheduleRetry(link);
          return;
        }
        link.opens.push(at);
        openStream(link, frame.data.stream);
        return;
      }
      case "close": if (link.stream?.id === frame.data.stream) endStream(link, false); return;
      case "bye": return; // the close code that follows says what happened
      case "ready": return;
      case "capture": void capture(link, frame.data.id); return;
    }
  }

  async function dial(link: Link): Promise<void> {
    if (disposed || link.socket || !prefs.computers[link.slot]?.enabled) return;
    setState(link, link.state === "on" ? "offline" : "connecting");
    let identity: PairedLinkIdentity | null;
    let token: string | null;
    try {
      identity = await options.pairing.linkIdentity(AbortSignal.timeout(HTTP_TIMEOUT_MS));
      token = identity ? await options.credential(link.slot) : null;
    } catch (error: unknown) {
      log(`dial setup failed: ${error instanceof Error ? error.name : "UnknownError"}`);
      setState(link, "offline");
      scheduleRetry(link);
      return;
    }
    // No longer paired (disconnected here or removed on the computer): stay off until paired again.
    if (!identity) { link.identity = null; link.consent.reset(); setState(link, "removed"); return; }
    if (!token) { setState(link, "offline"); scheduleRetry(link); return; }
    if (disposed || link.socket || !prefs.computers[link.slot]?.enabled) return;
    // A new pairing revision (or another device's key) starts consent over.
    if (link.identity && (link.identity.revision !== identity.revision || link.identity.deviceId !== identity.deviceId)) link.consent.reset();
    link.identity = identity;
    const socket = options.createSocket(urlFor(identity.origin, link.slot), { Authorization: `Bearer ${token}` });
    socket.binaryType = "arraybuffer";
    link.socket = socket;
    link.admitted = false;
    link.lastSeen = now();
    socket.onmessage = (event) => {
      if (link.socket !== socket) return;
      link.lastSeen = now();
      if (typeof event.data === "string") { onControl(link, identity, event.data); return; }
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
      link.consent.reset();
      // The pairing changed (removed on the computer, disconnected, re-paired): never
      // reconnect by itself; pairing again turns it back on.
      setState(link, "removed");
      const saved = prefs.computers[link.slot];
      if (saved) await savePrefs({ computers: { ...prefs.computers, [link.slot]: { ...saved, enabled: false } } });
      return;
    }
    if (code === DESKTOP_LINK_CLOSE.auth) {
      // Refused: read the pairing again. Still paired (a newer revision, say): try again
      // with backoff. Not paired here any more: stay off until paired again.
      try {
        const identity = await options.pairing.linkIdentity(AbortSignal.timeout(HTTP_TIMEOUT_MS));
        if (!identity) { link.consent.reset(); setState(link, "removed"); return; }
      } catch (error: unknown) {
        log(`pairing read failed: ${error instanceof Error ? error.name : "UnknownError"}`);
      }
      setState(link, "error");
      scheduleRetry(link);
      return;
    }
    if (code === DESKTOP_LINK_CLOSE.replaced) { setState(link, "offline"); return; }
    setState(link, "offline");
    scheduleRetry(link);
  }

  function sweep(): void {
    const at = now();
    for (const link of links.values()) {
      if (!link.socket) continue;
      if (!link.admitted) {
        // A connection that never reached `ready` (the network dropped mid-handshake) is retried, never left hanging.
        if (at - link.lastSeen > ADMISSION_DEADLINE_MS) { hangUp(link); setState(link, "offline"); scheduleRetry(link, true); }
        continue;
      }
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
      const created: Link = {
        slot, computerName, state: "off", socket: null, admitted: false, lastSeen: 0, failures: 0, opens: [], retry: null, stream: null,
        identity: null,
        consent: createDesktopLinkConsent({
          ask: (request, signal) => options.consent.ask(created.computerName, request, signal),
          // Full Access counts only for the pairing this link proves right now.
          fullAccess: async () => (created.identity ? options.consent.fullAccess(created.identity) : false),
          log,
        }),
      };
      link = created;
      links.set(slot, link);
    }
    link.computerName = computerName;
    return link;
  }

  return {
    /** Loads saved choices and reconnects every computer that is switched on. */
    async start(): Promise<void> {
      prefs = await options.preferences.load();
      for (const [slot, saved] of Object.entries(prefs.computers)) {
        const link = linkFor(slot, saved.computerName);
        if (saved.enabled) void dial(link);
      }
      await this.showPaired();
    },

    /**
     * A device paired before it had a saved choice (paired under 2698 before the
     * link existed, or signed in again): show it as paired and off, so it can be
     * turned on, instead of offering to pair it again.
     */
    async showPaired(computerName = "Matrix computer"): Promise<void> {
      if (links.has(PRIMARY)) return;
      let identity: PairedLinkIdentity | null;
      try {
        identity = await options.pairing.linkIdentity(AbortSignal.timeout(HTTP_TIMEOUT_MS));
      } catch (error: unknown) {
        log(`pairing read failed: ${error instanceof Error ? error.name : "UnknownError"}`);
        return;
      }
      if (!identity || links.has(PRIMARY) || disposed) return;
      changed(linkFor(PRIMARY, computerName.slice(0, 64)));
    },

    statuses(): DesktopLinkStatus[] { return [...links.values()].map(status); },
    /** This device's device id at its computer, from the last pairing it linked with (no key is read). */
    deviceIds(): string[] {
      return [...new Set(Object.values(prefs.computers).flatMap((saved) => (saved.deviceId ? [saved.deviceId] : [])))];
    },
    onStatus(listener: (status: DesktopLinkStatus) => void): () => void {
      events.on("status", listener);
      return () => { events.off("status", listener); };
    },

    /**
     * Turns the link on for the primary computer this device is paired with:
     * after pairing commits (2698), or when the person turns it back on after Stop.
     */
    async enable(slot: string, computerName: string): Promise<void> {
      if (slot !== PRIMARY) throw new DesktopLinkEnableError("denied");
      // A Stop (or sign-out) while the pairing is read wins: this enable then does nothing.
      const stopsAtStart = stops;
      let identity: PairedLinkIdentity | null;
      try {
        identity = await options.pairing.linkIdentity(AbortSignal.timeout(HTTP_TIMEOUT_MS));
      } catch (error: unknown) {
        log(`pairing read failed: ${error instanceof Error ? error.name : "UnknownError"}`);
        throw new DesktopLinkEnableError("unavailable");
      }
      if (!identity) throw new DesktopLinkEnableError("not_paired");
      if (stops !== stopsAtStart || disposed) return;
      const link = linkFor(slot, computerName.slice(0, 64));
      await savePrefs({ computers: { ...prefs.computers, [slot]: {
        enabled: true, computerName: link.computerName, machineId: identity.machineId, revision: identity.revision,
        deviceId: identity.deviceId,
      } } });
      link.failures = 0;
      if (link.retry) { clearTimeout(link.retry); link.retry = null; }
      if (link.socket) hangUp(link);
      void dial(link);
    },

    /** The person switched it off: the link closes now, before the preference is written. */
    async disable(slot: string): Promise<void> {
      stops += 1;
      const link = links.get(slot);
      if (link) {
        if (link.retry) { clearTimeout(link.retry); link.retry = null; }
        // Stop: every approval on screen ends, and nothing approved is remembered.
        link.consent.reset();
        sendText(link, { t: "bye", reason: "disabled" });
        hangUp(link);
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
    /**
     * From the auth hook. Signing out, or switching to another account or computer
     * without signing out, closes every link at once. Failures are logged here.
     */
    /** The account restored at startup, before any change: a later sign-in as someone else then closes its links. */
    seedAccount(status: { signedIn: boolean; userId?: string; handle?: string }): void {
      if (signedInAs === undefined) signedInAs = status.signedIn ? `${status.userId ?? ""}\u0000${status.handle ?? ""}` : null;
    },

    authChanged(status: { signedIn: boolean; userId?: string; handle?: string }): void {
      const account = status.signedIn ? `${status.userId ?? ""}\u0000${status.handle ?? ""}` : null;
      const previous = signedInAs;
      signedInAs = account;
      if (account !== null && (previous === undefined || previous === account)) return;
      this.signedOut().then(
        () => (account !== null ? this.showPaired(status.handle) : undefined),
        (error: unknown) => log(`sign-out cleanup failed: ${error instanceof Error ? error.name : "UnknownError"}`),
      );
    },

    /** Signed out or the account changed: every link closes, choices are forgotten. */
    async signedOut(): Promise<void> {
      stops += 1;
      for (const link of links.values()) {
        if (link.retry) { clearTimeout(link.retry); link.retry = null; }
        link.consent.reset();
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
        link.consent.reset();
        sendText(link, { t: "bye", reason: "quit" });
        hangUp(link);
      }
      links.clear();
      events.removeAllListeners();
    },
  };
}

export type DesktopLinkService = ReturnType<typeof createDesktopLinkService>;
