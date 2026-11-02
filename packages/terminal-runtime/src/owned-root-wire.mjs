// Private typed Root data codec. These bytes carry correlation, never authority.
import { createHash, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const unavailable = () => new Error('owned Root unavailable');
function fixed(value) {
  if (!Buffer.isBuffer(value) || value.length !== 32) throw unavailable();
  return Buffer.from(value);
}
function deadline(value) {
  if (typeof value !== 'bigint' || value <= 0n || value >= 1n << 64n) throw unavailable();
  const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes;
}
function text(value, max, absolute = false) {
  if (typeof value !== 'string' || value.includes('\0') || (absolute && !value.startsWith('/'))) throw unavailable();
  const bytes = Buffer.from(value);
  if (!bytes.length || bytes.length > max || utf8.decode(bytes) !== value) throw unavailable();
  return bytes;
}
function short(bytes) { const n = Buffer.alloc(2); n.writeUInt16LE(bytes.length); return Buffer.concat([n, bytes]); }
function prefix(fields) { return Buffer.concat([deadline(fields.deadlineNs), fixed(fields.generation), fixed(fields.nonce)]); }
function frame(magic, kind, body, max = 8192) {
  if (16 + body.length > max) throw unavailable();
  const head = Buffer.alloc(16); head.write(magic); head[8] = 1; head[9] = kind; head.writeUInt32LE(body.length, 12);
  return Buffer.concat([head, body]);
}
function header(bytes, magic, kind, max) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > max
      || bytes.subarray(0, 8).toString('latin1') !== magic || bytes[8] !== 1 || bytes[9] !== kind
      || bytes.readUInt16LE(10) !== 0 || bytes.readUInt32LE(12) !== bytes.length - 16) throw unavailable();
}
export function encodePreparation(fields) {
  if (typeof fields.sessionName !== 'string' || !/^matrix-rt_[0-9a-f]{32}$/.test(fields.sessionName)) throw unavailable();
  return frame('MXZPREP\0', 1, Buffer.concat([prefix(fields), short(text(fields.sessionName, 42)), short(text(fields.layoutPath, 4096, true))]));
}
function addressed(magic, kind, fields) {
  return frame(magic, kind, Buffer.concat([prefix(fields), short(text(fields.socketPath, 103, true))]));
}
export function encodeBootstrap(fields) { return addressed('MXZBOOT\0', 1, fields); }
export function encodeTarget(fields) { return addressed('MXZINIT\0', 2, fields); }
export function decodeBootstrapAck(bytes, fields) {
  header(bytes, 'MXZBOOT\0', 2, 8192);
  const expected = Buffer.concat([fixed(fields.generation), fixed(fields.nonce)]);
  if (bytes.length !== 80 || !timingSafeEqual(bytes.subarray(16), expected)) throw unavailable();
}
export function decodePreparedReply(bytes, fields) {
  header(bytes, 'MXZPREP\0', 2, 65536);
  if (bytes.length < 130 || !timingSafeEqual(bytes.subarray(16, 88), prefix(fields)) || bytes.readBigUInt64LE(88) !== 4n) throw unavailable();
  const end = bytes.length - 32;
  const digest = createHash('sha256').update('matrix-private-env-v1\0').update(bytes.subarray(96, end)).digest();
  if (!timingSafeEqual(digest, bytes.subarray(end))) throw unavailable();
  let offset = 98, total = 0, previous;
  const count = bytes.readUInt16LE(96), environment = Object.create(null);
  if (count > 512) throw unavailable();
  function string(max, key) {
    if (offset + 2 > end) throw unavailable();
    const length = bytes.readUInt16LE(offset); offset += 2;
    if (length > max || (key && length === 0) || offset + length > end) throw unavailable();
    const raw = bytes.subarray(offset, offset + length); offset += length;
    const value = utf8.decode(raw);
    if (value.includes('\0') || (key && value.includes('='))) throw unavailable();
    return { raw, value };
  }
  for (let n = 0; n < count; n++) {
    const key = string(256, true), value = string(16384, false);
    total += key.raw.length + value.raw.length + 2;
    if (total > 49152 || (previous && Buffer.compare(previous, key.raw) >= 0)) throw unavailable();
    previous = key.raw; environment[key.value] = value.value;
  }
  if (offset !== end) throw unavailable();
  return environment;
}
