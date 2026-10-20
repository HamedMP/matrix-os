import { Duplex } from 'node:stream';

const ready = Buffer.from([90, 0, 0, 0, 5, 73]);
// Exercise the real pg Client and Pool lifecycle without a network dependency.
export class PostgresSocket extends Duplex {
  private startup = true;
  holdQueries = false;
  readonly statements: string[] = [];
  connect() { queueMicrotask(() => this.emit('connect')); }
  setNoDelay() {}
  ref() {}
  unref() {}
  _read() {}
  _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
    if (this.startup) {
      this.startup = false;
      queueMicrotask(() => this.push(Buffer.concat([
        Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0]), ready,
      ])));
    } else if (chunk[0] === 81) {
      this.statements.push(chunk.toString('utf8', 5, chunk.length - 1));
      if (!this.holdQueries) queueMicrotask(() => this.push(Buffer.concat([
        Buffer.from([67, 0, 0, 0, 13]), Buffer.from('SELECT 1\0'), ready,
      ])));
    } else if (chunk[0] === 88) {
      this.destroy();
    }
    callback();
  }
}
