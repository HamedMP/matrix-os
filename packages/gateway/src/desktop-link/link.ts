// One admitted Desktop link (spec 2716): a WebSocket the desktop opened to this
// gateway. It carries at most one herdr-core byte stream at a time, opened
// and closed with text control frames; binary frames are that stream's bytes.
import { EventEmitter } from "node:events";
import type { HcSocket } from "@matrix-os/herdr-core-client/client";
import { HerdrTransportError } from "@matrix-os/herdr-core-client/session-host";
import { DESKTOP_LINK_CLOSE, type DesktopLinkClientFrame, type DesktopLinkServerFrame } from "@matrix-os/contracts/desktop-link";

/** A link that queued more than this for the desktop is not keeping up: closed, not buffered. */
export const DESKTOP_LINK_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export interface DesktopLinkTransport {
  sendText(text: string): void;
  sendBinary(bytes: Buffer): void;
  bufferedAmount(): number;
  close(code: number): void;
}

export interface DesktopLinkInfo { deviceId: string; name: string; appVersion: string; os: string }

export interface DesktopLink {
  readonly info: DesktopLinkInfo;
  readonly closed: boolean;
  lastSeen(): number;
  /** A fresh core stream to the desktop's private herdr-core. Ends any stream still open. */
  openStream(): Promise<HcSocket>;
  /** From the WebSocket: a text frame already validated, or a binary frame. */
  receiveControl(frame: DesktopLinkClientFrame): void;
  receiveBinary(bytes: Buffer): void;
  send(frame: DesktopLinkServerFrame): void;
  /** The WebSocket closed or is being closed: ends the stream. Idempotent. */
  closedBy(code: number): void;
  close(code: number): void;
}

class LinkStream extends EventEmitter implements HcSocket {
  ended = false;
  constructor(readonly id: number, private readonly link: { write(id: number, bytes: Buffer): void; end(id: number): void }) {
    super();
  }
  write(data: Buffer | string): boolean {
    if (this.ended) return false;
    this.link.write(this.id, typeof data === "string" ? Buffer.from(data) : data);
    return true;
  }
  destroy(): void { this.link.end(this.id); }
  /** The stream is over: tells its reader once. */
  finish(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    if (error && this.listenerCount("error") > 0) this.emit("error", error);
    this.emit("close");
  }
}

export function createDesktopLink(options: {
  info: DesktopLinkInfo;
  transport: DesktopLinkTransport;
  now?: () => number;
  log?: (message: string) => void;
}): DesktopLink {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.warn(`[desktop-link] ${message}`));
  let seen = now();
  let nextStream = 1;
  let stream: LinkStream | null = null;
  let closed = false;

  function sendFrame(frame: DesktopLinkServerFrame): void {
    if (closed) return;
    options.transport.sendText(JSON.stringify(frame));
  }

  function endStream(error?: Error): void {
    const current = stream;
    stream = null;
    current?.finish(error);
  }

  const link: DesktopLink = {
    info: options.info,
    get closed() { return closed; },
    lastSeen: () => seen,
    openStream() {
      if (closed) return Promise.reject(new HerdrTransportError("unavailable"));
      if (stream) {
        sendFrame({ t: "close", stream: stream.id });
        endStream();
      }
      const opened = new LinkStream(nextStream++, {
        write(id, bytes) {
          if (closed || stream?.id !== id) return;
          if (options.transport.bufferedAmount() + bytes.length > DESKTOP_LINK_MAX_BUFFERED_BYTES) {
            log(`link for ${options.info.deviceId.slice(0, 12)} fell behind; closing`);
            link.close(DESKTOP_LINK_CLOSE.policy);
            return;
          }
          options.transport.sendBinary(bytes);
        },
        end(id) {
          if (stream?.id !== id) return;
          sendFrame({ t: "close", stream: id });
          endStream();
        },
      });
      stream = opened;
      sendFrame({ t: "open", stream: opened.id });
      return Promise.resolve(opened);
    },
    receiveControl(frame) {
      seen = now();
      if (frame.t === "ping") { sendFrame({ t: "pong" }); return; }
      if (frame.t === "end") { if (stream?.id === frame.stream) endStream(); return; }
      if (frame.t === "bye") link.close(DESKTOP_LINK_CLOSE.going);
    },
    receiveBinary(bytes) {
      seen = now();
      // Bytes for a stream that already ended here are dropped: the desktop sends its
      // `end` after them, and a new stream starts only after `open`.
      if (stream && !stream.ended) stream.emit("data", bytes);
    },
    send: sendFrame,
    closedBy() {
      if (closed) return;
      closed = true;
      endStream(new HerdrTransportError("unavailable"));
    },
    close(code) {
      if (closed) return;
      link.closedBy(code);
      try {
        options.transport.close(code);
      } catch (error: unknown) {
        log(`close failed: ${error instanceof Error ? error.name : "UnknownError"}`);
      }
    },
  };
  return link;
}
