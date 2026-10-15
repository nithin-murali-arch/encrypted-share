import type { Socket } from 'net';
import { FrameReader, MAX_MESSAGE_BYTES, TransferError } from './protocol';

export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export class SocketChannel {
  private readonly reader = new FrameReader();
  private waiters: Array<() => void> = [];
  private closed = false;
  private failure: TransferError | null = null;

  constructor(
    private readonly socket: Socket,
    private readonly idleTimeoutMs?: number,
  ) {
    socket.on('data', (chunk: Buffer) => {
      this.reader.push(chunk);
      this.notify();
    });
    socket.on('close', () => {
      this.closed = true;
      this.notify();
    });
    socket.on('error', (err: Error) => {
      this.failure ??= new TransferError('transfer-failed', `connection failed: ${err.message}`);
      this.notify();
    });
    if (idleTimeoutMs !== undefined) {
      socket.on('timeout', () => {
        this.failure ??= new TransferError('timeout', `no data from the peer for ${idleTimeoutMs / 1000} s`);
        socket.destroy();
        this.notify();
      });
      socket.setTimeout(idleTimeoutMs);
      socket.setKeepAlive(true, idleTimeoutMs);
    }
  }

  // For waits on the peer's disk work (hashing partials or the final verify),
  // when no bytes flow however healthy the peer is. Keepalive probes still
  // detect a peer host that vanished.
  async withoutIdleTimeout<T>(work: () => Promise<T>): Promise<T> {
    if (this.idleTimeoutMs === undefined) return work();
    this.socket.setTimeout(0);
    try {
      return await work();
    } finally {
      this.socket.setTimeout(this.idleTimeoutMs);
    }
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
      if (this.failure) throw this.failure;
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
    if (this.failure) throw this.failure;
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
        reject(this.failure ?? new TransferError('truncated', 'connection closed mid-transfer'));
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
