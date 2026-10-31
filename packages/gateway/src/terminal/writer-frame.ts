/** Kernel observations only. No member may be taken from a request body. */
export interface KernelWriter { pid: number; uid: number; gid: number }
export function sameKernelWriter(left: KernelWriter, right: KernelWriter): boolean {
  return left.pid === right.pid && left.uid === right.uid && left.gid === right.gid;
}
/** One frame per accepted connection. Credentials accompany EVERY recvmsg chunk,
 * not merely accept(); transferred/inherited descriptors cannot borrow the creator.
 * This does not isolate a hostile same-UID debugger or a cooperating admitted root. */
export function createWriterFrame(creator: KernelWriter, limit = 32768) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 32768) throw new Error("Terminal proof unavailable");
  const captured = Object.freeze({ ...creator }), parts: Buffer[] = []; // Total bytes <=limit, cleared on completion/failure.
  let size = 0, closed = false;
  const deny = (): never => { closed = true; parts.length = 0; throw new Error("Terminal proof unavailable"); };
  return {
    push(chunk: { data: Buffer; writer?: KernelWriter }): { bytes: string; writer: KernelWriter } | undefined {
      if (closed || !chunk.writer || !sameKernelWriter(captured, chunk.writer) || !chunk.data.length) return deny();
      size += chunk.data.length;
      if (size > limit) return deny();
      const newline = chunk.data.indexOf(10);
      if (newline !== -1 && newline !== chunk.data.length - 1) return deny();
      parts.push(Buffer.from(chunk.data));
      if (newline === -1) return undefined;
      closed = true;
      const bytes = Buffer.concat(parts, size); parts.length = 0;
      if (bytes.length <= 1) return deny();
      try { return { bytes: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1)), writer: captured }; }
      catch (error) { if (!(error instanceof TypeError)) throw error; return deny(); }
    },
  };
}
