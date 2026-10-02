import { createServer } from 'net';
import type { Socket } from 'net';
import { SocketChannel } from './channel';
import { deriveKey, openChunk } from './crypto';
import {
  decodeChunk,
  decodeHeader,
  deriveNonce,
  encodeMessage,
  HEADER_PREFIX_LENGTH,
  IV_BASE_LENGTH,
  MAX_CHUNK_BYTES,
  readHeaderLength,
  ResumeMessage,
  ResultMessage,
  SALT_LENGTH,
  TransferError,
} from './protocol';
import { PartialStore } from './store';

export interface ServerOptions {
  port: number;
  password: string | Buffer;
  outDir: string;
  overwrite?: boolean;
  onTransfer?: (msg: string) => void;
}

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

async function handleConnection(
  socket: Socket,
  password: string | Buffer,
  outDir: string,
  overwrite: boolean,
  log: (msg: string) => void,
): Promise<void> {
  const ch = new SocketChannel(socket);
  try {
    const prefix = await ch.readExact(HEADER_PREFIX_LENGTH);
    const headerLen = readHeaderLength(prefix);
    const rest = await ch.readExact(headerLen);
    const header = decodeHeader(Buffer.concat([prefix, rest]));
    if (header.chunkSize > MAX_CHUNK_BYTES) {
      throw new TransferError('bad-header', `chunkSize ${header.chunkSize} exceeds max`);
    }
    const salt = Buffer.from(header.salt, 'base64');
    const baseNonce = Buffer.from(header.baseNonce, 'base64');
    if (salt.length !== SALT_LENGTH || baseNonce.length !== IV_BASE_LENGTH) {
      throw new TransferError('bad-header', 'bad salt or base nonce');
    }
    const key = deriveKey(password, salt);
    const store = new PartialStore({ outDir, overwrite });
    let received: Record<string, number>;
    try {
      received = await store.prepare(header.files, header.dirs);
    } catch (err) {
      const msg: ResumeMessage = { received: {}, error: (err as Error).message };
      await ch.write(encodeMessage(msg));
      return;
    }
    await ch.write(encodeMessage({ received } satisfies ResumeMessage));
    log(`incoming transfer: ${header.files.length} file(s), ${header.dirs.length} dir(s)`);

    let counter = 0n;
    const maxFrame = header.chunkSize + 64;
    for (;;) {
      const frame = await ch.readFrame(maxFrame);
      if (frame.length === 0) break;
      const { header: chunk, ciphertext, tag } = decodeChunk(frame);
      const plaintext = openChunk(key, deriveNonce(baseNonce, counter), ciphertext, tag);
      counter += 1n;
      await store.append(chunk.fileIndex, chunk.offset, plaintext);
    }
    const result: ResultMessage = await store.verifyAndLand();
    await ch.write(encodeMessage(result));
    await ch.end();
    log(
      result.ok
        ? `transfer complete: ${result.verified.length} file(s) verified`
        : `transfer failed verification: ${result.failed.map((f) => f.path).join(', ')}`,
    );
  } finally {
    ch.destroy();
  }
}

export async function startServer(opts: ServerOptions): Promise<ServerHandle> {
  const log = opts.onTransfer ?? ((): void => {});
  const server = createServer((socket) => {
    handleConnection(socket, opts.password, opts.outDir, opts.overwrite === true, log).catch(
      (err: Error) => {
        log(`transfer failed: ${err.message}`);
        socket.destroy();
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  server.on('error', (err: Error) => log(`server error: ${err.message}`));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : opts.port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      }),
  };
}
