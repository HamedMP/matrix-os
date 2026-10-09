/** Browser-to-browser collaboration. Signaling is copied manually; no Matrix relay is used. */
export const ICE_CONFIG = { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] };
export const MAX_TRANSFER_BYTES = 20 * 1024 * 1024;
export const CHUNK_BYTES = 16 * 1024;
export const MAX_STROKES = 400;
const MAX_SIGNAL_CHARS = 250_000;
const MAX_CONTROL_CHARS = 32_000;
const SEND_HIGH_WATER = 256 * 1024;
const SEND_LOW_WATER = 64 * 1024;
const ID = /^[a-f0-9-]{1,64}$/i;

function validDescription(value, expected) {
  if (!value || typeof value !== "object" || !["offer", "answer"].includes(value.type) || expected && value.type !== expected || typeof value.sdp !== "string" || value.sdp.length > 200_000 || !/^v=0(?:\r?\n|$)/.test(value.sdp)) throw new Error(`Enter a valid ${expected || "connection"} code.`);
  return { type: value.type, sdp: value.sdp };
}

export function serializeSignal(description) {
  const text = JSON.stringify(validDescription(description));
  if (text.length > MAX_SIGNAL_CHARS) throw new Error("Connection code is too long.");
  return text;
}

export function parseSignal(text, expected) {
  if (typeof text !== "string" || text.length > MAX_SIGNAL_CHARS) throw new Error("Connection code is too long.");
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`Enter a valid ${expected || "connection"} code.`); }
  return validDescription(parsed, expected);
}

/** Manual signaling requires all candidates inside the copied SDP. */
export function waitForIceGathering(peer, timeoutMs = 15_000) {
  if (!peer?.localDescription) return Promise.reject(new Error("Create a connection offer first."));
  if (peer.iceGatheringState === "complete") return Promise.resolve(peer.localDescription);
  return new Promise((resolve, reject) => {
    const timeout = Math.min(30_000, Math.max(1, Number(timeoutMs) || 15_000));
    const finish = (error) => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", check);
      peer.removeEventListener("connectionstatechange", check);
      if (error) reject(error); else resolve(peer.localDescription);
    };
    const check = () => {
      if (peer.connectionState === "closed" || peer.connectionState === "failed") finish(new Error("Connection closed while gathering network candidates."));
      else if (peer.iceGatheringState === "complete") finish();
    };
    const timer = setTimeout(() => finish(new Error("Could not gather network candidates in time. Try another network or browser.")), timeout);
    peer.addEventListener("icegatheringstatechange", check);
    peer.addEventListener("connectionstatechange", check);
    check();
  });
}

function cleanName(name) {
  const last = String(name || "shared-file").replaceAll("\\", "/").split("/").pop() || "shared-file";
  return last.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, "-").slice(0, 120) || "shared-file";
}

export function validateStroke(stroke) {
  if (!stroke || typeof stroke !== "object" || !/^#[0-9a-f]{6}$/i.test(stroke.color)) throw new Error("Choose a valid stroke color.");
  if (!Number.isInteger(stroke.width) || stroke.width < 1 || stroke.width > 20) throw new Error("Stroke width must be 1 to 20.");
  if (!Array.isArray(stroke.points) || stroke.points.length < 2 || stroke.points.length > 512) throw new Error("A stroke must contain 2 to 512 points.");
  for (const point of stroke.points) if (!Array.isArray(point) || point.length !== 2 || point.some((n) => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1)) throw new Error("Stroke points must be inside the board.");
  return { color: stroke.color.toLowerCase(), width: stroke.width, points: stroke.points.map(([x, y]) => [x, y]) };
}

function assertChannel(channel) {
  if (channel?.readyState !== "open") throw new Error("Connect to a peer before sharing.");
}

function waitForDrain(channel, timeoutMs = 15_000) {
  assertChannel(channel);
  if (channel.bufferedAmount <= SEND_HIGH_WATER) return Promise.resolve();
  channel.bufferedAmountLowThreshold = SEND_LOW_WATER;
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); channel.removeEventListener("bufferedamountlow", check); channel.removeEventListener("close", closed); channel.removeEventListener("error", closed); };
    const check = () => { if (channel.bufferedAmount <= SEND_LOW_WATER) { cleanup(); resolve(); } };
    const closed = () => { cleanup(); reject(new Error("The peer connection closed during transfer.")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("File transfer paused for too long. Try again.")); }, timeoutMs);
    channel.addEventListener("bufferedamountlow", check);
    channel.addEventListener("close", closed);
    channel.addEventListener("error", closed);
    check();
  });
}

/** One ordered RTCDataChannel carries bounded binary file chunks and small board messages. */
/**
 * @param {RTCDataChannel} channel
 * @param {{
 *   onFile?: (file: {name:string,blob:Blob,size:number}) => void | Promise<void>,
 *   onProgress?: (progress: {direction:string,bytes:number,total:number}) => void,
 *   onStroke?: (stroke: {color:string,width:number,points:number[][]}) => void,
 *   onClear?: () => void,
 *   onError?: (error: Error) => void
 * }} callbacks
 */
export function createTransferProtocol(channel, { onFile = () => {}, onProgress = () => {}, onStroke = () => {}, onClear = () => {}, onError = () => {} } = {}) {
  if (!channel || typeof channel.send !== "function") throw new Error("A data channel is required.");
  channel.binaryType = "arraybuffer";
  let receiving = null, pendingAck = null, queue = Promise.resolve(), disposed = false;
  const fail = (message) => { receiving = null; onError(new Error(message)); };

  async function process(data) {
    if (disposed) return;
    if (typeof data === "string") {
      if (data.length > MAX_CONTROL_CHARS) { fail("Peer sent an oversized control message."); return; }
      let message;
      try { message = JSON.parse(data); }
      catch { fail("Peer sent an invalid control message."); return; }
      if (message?.type === "file-start") {
        if (receiving || !ID.test(message.id || "") || !Number.isSafeInteger(message.size) || message.size < 0 || message.size > MAX_TRANSFER_BYTES || typeof message.name !== "string" || message.name.length > 250 || typeof message.mime !== "string" || message.mime.length > 100) { fail("Peer file must be valid and 20 MB or smaller."); return; }
        receiving = { id: message.id, name: cleanName(message.name), size: message.size, mime: message.mime, parts: [], bytes: 0 };
        onProgress({ direction: "receive", bytes: 0, total: receiving.size });
      } else if (message?.type === "file-end") {
        if (!receiving || message.id !== receiving.id || receiving.bytes !== receiving.size) { fail("Peer file transfer ended before all bytes arrived."); return; }
        const file = { name: receiving.name, blob: new Blob(receiving.parts, { type: "application/octet-stream" }), size: receiving.size };
        const id = receiving.id;
        receiving = null;
        await onFile(file);
        if (channel.readyState === "open") channel.send(JSON.stringify({ type: "file-ack", id }));
      } else if (message?.type === "file-ack") {
        if (pendingAck && message.id === pendingAck.id) { const ack = pendingAck; pendingAck = null; clearTimeout(ack.timer); ack.resolve(); }
      } else if (message?.type === "board-stroke") {
        try { onStroke(validateStroke(message.stroke)); }
        catch { fail("Peer sent an invalid whiteboard stroke."); }
      } else if (message?.type === "board-clear") { onClear(); }
      else fail("Peer sent an unsupported message.");
      return;
    }
    if (!receiving) { fail("Peer sent an unexpected file chunk."); return; }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data instanceof Uint8Array ? data : null;
    if (!bytes || bytes.length < 1 || bytes.length > CHUNK_BYTES || receiving.bytes + bytes.length > receiving.size) { fail("Peer sent an invalid file chunk."); return; }
    receiving.parts.push(bytes); receiving.bytes += bytes.length;
    onProgress({ direction: "receive", bytes: receiving.bytes, total: receiving.size });
  }

  function handleMessage(data) {
    queue = queue.then(() => process(data)).catch((error) => fail(error instanceof Error ? error.message : "Could not process peer data."));
    return queue;
  }

  /** @param {File} file @param {(progress: {direction:string,bytes:number,total:number}) => void} progress */
  async function sendFile(file, progress = () => {}) {
    assertChannel(channel);
    if (disposed || pendingAck) throw new Error("Finish the current transfer first.");
    if (!file || typeof file.slice !== "function" || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_TRANSFER_BYTES) throw new Error("Choose a file of 20 MB or smaller.");
    const id = globalThis.crypto.randomUUID();
    const ackPromise = new Promise((resolve, reject) => {
      pendingAck = { id, timer: null, resolve, reject };
    });
    // Avoid an unhandled rejection if the peer closes while chunks are still being read.
    ackPromise.catch(() => {});
    try {
      channel.send(JSON.stringify({ type: "file-start", id, name: cleanName(file.name), size: file.size, mime: String(file.type || "application/octet-stream").slice(0, 100) }));
      let sent = 0;
      for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
        await waitForDrain(channel);
        const bytes = await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer();
        assertChannel(channel);
        channel.send(bytes);
        sent += bytes.byteLength;
        progress({ direction: "send", bytes: sent, total: file.size });
      }
      await waitForDrain(channel);
      channel.send(JSON.stringify({ type: "file-end", id }));
      if (pendingAck?.id === id) pendingAck.timer = setTimeout(() => {
        if (pendingAck?.id === id) { const ack = pendingAck; pendingAck = null; ack.reject(new Error("Peer did not confirm the file transfer.")); }
      }, 60_000);
      await ackPromise;
    } catch (error) {
      if (pendingAck?.id === id) { clearTimeout(pendingAck.timer); pendingAck.reject(error); pendingAck = null; }
      throw error;
    }
  }

  function sendStroke(stroke) { assertChannel(channel); const valid = validateStroke(stroke); channel.send(JSON.stringify({ type: "board-stroke", stroke: valid })); }
  function clearBoard() { assertChannel(channel); channel.send(JSON.stringify({ type: "board-clear" })); }
  function dispose() {
    disposed = true; receiving = null;
    if (pendingAck) { clearTimeout(pendingAck.timer); pendingAck.reject(new Error("The peer connection closed.")); pendingAck = null; }
  }
  return { handleMessage, sendFile, sendStroke, clearBoard, dispose };
}
