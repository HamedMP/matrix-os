import {
  ProtocolResponseSchema,
  type ProtocolResponse,
} from './contracts.js';
import {
  decodeFrame,
  encodeFrame,
  MAX_FRAME_BYTES,
} from './framing.js';

export type PeerCredentials = {
  pid: number;
  uid: number;
  gid: number;
};

export function decodePeerCredentials(bytes: Buffer): PeerCredentials {
  if (bytes.byteLength !== 12) throw new Error('peer_credentials_invalid');
  const peer = {
    pid: bytes.readUInt32LE(0),
    uid: bytes.readUInt32LE(4),
    gid: bytes.readUInt32LE(8),
  };
  if (peer.pid < 1 || peer.uid > 0x7fff_ffff || peer.gid > 0x7fff_ffff) {
    throw new Error('peer_credentials_invalid');
  }
  return peer;
}

function invalidResponse(): ProtocolResponse {
  return {
    version: 1,
    ok: false,
    error: { code: 'invalid_request', message: 'Request failed' },
  };
}

export async function handleSupervisorFrame(options: {
  peer: PeerCredentials;
  matrixUid: number;
  request: Buffer;
  handler(request: unknown): Promise<ProtocolResponse>;
}): Promise<Buffer> {
  if (
    !Number.isSafeInteger(options.matrixUid) ||
    options.matrixUid < 1 ||
    options.peer.uid !== options.matrixUid
  ) {
    return encodeFrame(invalidResponse());
  }
  if (options.request.byteLength > MAX_FRAME_BYTES + 4) {
    return encodeFrame(invalidResponse());
  }
  try {
    const request = decodeFrame(options.request);
    const response = ProtocolResponseSchema.parse(await options.handler(request));
    return encodeFrame(response);
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    return encodeFrame(invalidResponse());
  }
}
