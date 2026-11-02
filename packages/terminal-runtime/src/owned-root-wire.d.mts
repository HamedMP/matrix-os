/// Correlation/data codecs only; no process/source proof is represented.
export interface Correlation { deadlineNs: bigint; generation: Buffer; nonce: Buffer }
export interface Preparation extends Correlation { sessionName: string; layoutPath: string }
export interface Addressed extends Correlation { socketPath: string }
export function encodePreparation(fields: Preparation): Buffer;
export function decodePreparedReply(bytes: Buffer, expected: Correlation): Record<string, string>;
export function encodeBootstrap(fields: Addressed): Buffer;
export function encodeTarget(fields: Addressed): Buffer;
export function decodeBootstrapAck(bytes: Buffer, expected: Pick<Correlation, 'generation' | 'nonce'>): void;
