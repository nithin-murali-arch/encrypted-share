import { createServer } from 'net';
import type { Socket } from 'net';
import { SocketChannel } from './channel';
import { deriveKey, deriveSessionKeys, randomServerNonce } from './crypto';
import {
  CHUNK_FRAME_OVERHEAD,
  encodeHello,
  encodeLegacyRejection,
  FrameType,
  HELLO_PREFIX_LENGTH,
  MAX_CHUNK_BYTES,
  MAX_MESSAGE_BYTES,
  parseHelloPrefix,
  ResultMessage,
  SALT_LENGTH,
  TransferError,
} from './protocol';
import { SecureChannel } from './secure-channel';
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

const LEGACY_CLIENT_ERROR =
  'this server runs encrypted-share 3 (wire protocol ES03); upgrade the sender to encrypted-share 3.x';

async function rejectLegacyClient(ch: SocketChannel): Promise<void> {
  // Closing with the old header still unread makes the kernel send RST, which can
  // discard the rejection before the old client reads it.
  const legacyHeaderLength = (await ch.readExact(4)).readUInt32BE(0);
  if (legacyHeaderLength <= MAX_MESSAGE_BYTES) await ch.readExact(legacyHeaderLength);
  await ch.write(encodeLegacyRejection(LEGACY_CLIENT_ERROR));
  await ch.end();
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
    const prefix = await ch.readExact(HELLO_PREFIX_LENGTH);
    if (parseHelloPrefix(prefix) === 'legacy') {
      await rejectLegacyClient(ch);
      log('rejected an encrypted-share 2.x sender (wire protocol ES02); it must upgrade to 3.x');
      return;
    }
    const clientSalt = await ch.readExact(SALT_LENGTH);
    const serverNonce = randomServerNonce();
    await ch.write(encodeHello(serverNonce));
    const keys = deriveSessionKeys(deriveKey(password, clientSalt), clientSalt, serverNonce);
    const sc = new SecureChannel(ch, keys, 'server');

    const { body: header } = await sc.recv([FrameType.HEADER]);
    if (header.chunkSize > MAX_CHUNK_BYTES) {
      throw new TransferError('bad-header', `chunkSize ${header.chunkSize} exceeds max`);
    }
    const store = new PartialStore({ outDir, overwrite });
    let received: Record<string, number>;
    try {
      received = await store.prepare(header.files, header.dirs);
    } catch (err) {
      await sc.send(FrameType.RESUME, { received: {}, error: (err as Error).message });
      return;
    }
    await sc.send(FrameType.RESUME, { received });
    log(`incoming transfer: ${header.files.length} file(s), ${header.dirs.length} dir(s)`);

    const maxChunkFrame = header.chunkSize + CHUNK_FRAME_OVERHEAD;
    for (;;) {
      const frame = await sc.recv([FrameType.CHUNK, FrameType.DONE], maxChunkFrame);
      if (frame.type === FrameType.DONE) break;
      await store.append(frame.body.fileIndex, frame.body.offset, frame.body.data);
    }
    const result: ResultMessage = await store.verifyAndLand();
    await sc.send(FrameType.RESULT, result);
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
