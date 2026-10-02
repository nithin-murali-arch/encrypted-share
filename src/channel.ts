import type { Socket } from 'net';
import { FrameReader, MAX_MESSAGE_BYTES, TransferError } from './protocol';

export class SocketChannel {
  private readonly reader = new FrameReader();
  private waiters: Array<() => void> = [];
  private closed = false;
  private failure: Error | null = null;

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.reader.push(chunk);
      this.notify();
    });
    socket.on('close', () => {
      this.closed = true;
      this.notify();
    });
    socket.on('error', (err: Error) => {
      if (!this.failure) this.failure = err;
      this.notify();
    });
  }

  private notify(): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const fn of pending) fn();
  }

  private async waitFor(poll: () => Buffer | null): Promise<Buffer> {
    for (;;) {
      const got = poll();
      if (got) return got;
      if (this.failure) {
        throw new TransferError('transfer-failed', `connection failed: ${this.failure.message}`);
      }
      if (this.closed) {
        throw new TransferError('truncated', 'connection closed mid-transfer');
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }

  readExact(bytes: number): Promise<Buffer> {
    return this.waitFor(() => this.reader.take(bytes));
  }

  readFrame(maxBytes: number = MAX_MESSAGE_BYTES): Promise<Buffer> {
    return this.waitFor(() => this.reader.takeFrame(maxBytes));
  }

  async write(buf: Buffer): Promise<void> {
    if (this.failure) {
      throw new TransferError('transfer-failed', `connection failed: ${this.failure.message}`);
    }
    if (this.closed) {
      throw new TransferError('truncated', 'connection closed mid-transfer');
    }
    const socket = this.socket;
    let flushed: boolean;
    try {
      flushed = socket.write(buf);
    } catch (err) {
      throw new TransferError('transfer-failed', `write failed: ${(err as Error).message}`);
    }
    if (flushed) return;
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(new TransferError('transfer-failed', `connection failed: ${err.message}`));
      };
      const onClose = (): void => {
        cleanup();
        reject(new TransferError('truncated', 'connection closed mid-transfer'));
      };
      const cleanup = (): void => {
        socket.removeListener('drain', onDrain);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
      };
      socket.once('drain', onDrain);
      socket.once('error', onError);
      socket.once('close', onClose);
    });
  }

  end(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.end(() => resolve());
    });
  }

  destroy(): void {
    this.socket.destroy();
  }
}
