export interface BufferChunk {
  seq: number;
  data: string;
}

export class RingBuffer {
  private chunks: BufferChunk[] = [];
  private _currentBytes = 0;
  private _nextSeq = 0;
  private readonly maxBytes: number;

  constructor(maxBytes = 5 * 1024 * 1024) {
    this.maxBytes = maxBytes;
  }

  write(data: string): number | null {
    const byteLen = Buffer.byteLength(data);

    if (byteLen > this.maxBytes) {
      return null;
    }

    const seq = this._nextSeq++;

    while (this.chunks.length > 0 && this._currentBytes + byteLen > this.maxBytes) {
      const evicted = this.chunks.shift()!;
      this._currentBytes -= Buffer.byteLength(evicted.data);
    }

    this.chunks.push({ seq, data });
    this._currentBytes += byteLen;
    return seq;
  }

  getSince(seq: number): BufferChunk[] {
    return this.chunks.filter((c) => c.seq >= seq);
  }

  getAll(): BufferChunk[] {
    return [...this.chunks];
  }

  clear(): void {
    this.chunks = [];
    this._currentBytes = 0;
  }

  get currentBytes(): number {
    return this._currentBytes;
  }

  get capacityBytes(): number {
    return this.maxBytes;
  }

  get nextSeq(): number {
    return this._nextSeq;
  }
}
