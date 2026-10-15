import { open } from 'fs/promises';
import { connect } from 'net';
import { join } from 'path';
import { DEFAULT_IDLE_TIMEOUT_MS, SocketChannel } from './channel';
import { deriveKey, deriveSessionKeys, randomSalt } from './crypto';
import { buildManifest, WarnFn } from './manifest';
import {
  decodeHello,
  DEFAULT_CHUNK_SIZE,
  encodeHello,
  FrameType,
  HELLO_LENGTH,
  MAX_CHUNK_BYTES,
  TransferError,
} from './protocol';
import { SecureChannel } from './secure-channel';

export interface SendOptions {
  host: string;
  port: number;
  password: string | Buffer;
  path: string;
  chunkSize?: number;
  idleTimeoutMs?: number;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  onWarn?: WarnFn;
}

export interface SendReport {
  files: string[];
  bytes: number;
}

async function whenConnectionLost<T>(pending: Promise<T>, code: string, message: string): Promise<T> {
  try {
    return await pending;
  } catch (err) {
    if (err instanceof TransferError && (err.code === 'truncated' || err.code === 'transfer-failed')) {
      throw new TransferError(code, message);
    }
    throw err;
  }
}

export async function clientHandshake(
  ch: SocketChannel,
  password: string | Buffer,
): Promise<SecureChannel> {
  const clientSalt = randomSalt();
  const ikm = deriveKey(password, clientSalt);
  await ch.write(encodeHello(clientSalt));
  const hello = await whenConnectionLost(
    ch.readExact(HELLO_LENGTH),
    'handshake-failed',
    'server closed the connection during the handshake; it may run encrypted-share 2.x or an incompatible version',
  );
  const serverNonce = decodeHello(hello);
  return new SecureChannel(ch, deriveSessionKeys(ikm, clientSalt, serverNonce), 'client');
}

export async function sendFiles(opts: SendOptions): Promise<SendReport> {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize > MAX_CHUNK_BYTES) {
    throw new TransferError('bad-config', `invalid chunk size: ${chunkSize}`);
  }
  const manifest = await buildManifest(opts.path, opts.onWarn);

  const socket = connect(opts.port, opts.host);
  await new Promise<void>((resolve, reject) => {
    const onConnect = (): void => {
      socket.removeListener('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      socket.removeListener('connect', onConnect);
      reject(new TransferError('connect-failed', `cannot connect to ${opts.host}:${opts.port}: ${err.message}`));
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });

  const ch = new SocketChannel(socket, opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  try {
    const sc = await clientHandshake(ch, opts.password);
    await sc.send(FrameType.HEADER, { chunkSize, files: manifest.files, dirs: manifest.dirs });
    const { body: resume } = await whenConnectionLost(
      ch.withoutIdleTimeout(() => sc.recv([FrameType.RESUME])),
      'rejected',
      'server closed the connection after the header; check that both sides use the same password',
    );
    if (resume.error) {
      throw new TransferError('rejected', `server rejected transfer: ${resume.error}`);
    }

    let sent = 0;
    opts.onProgress?.(0, manifest.totalBytes);
    for (let i = 0; i < manifest.files.length; i++) {
      const entry = manifest.files[i];
      const skip = resume.received[entry.path] ?? 0;
      if (!Number.isInteger(skip) || skip < 0 || skip > entry.size) {
        throw new TransferError('bad-resume', `server reported invalid offset for ${entry.path}`);
      }
      if (skip === entry.size) continue;
      const fullPath = join(manifest.root, ...entry.path.split('/'));
      const fh = await open(fullPath, 'r');
      try {
        const buf = Buffer.alloc(chunkSize);
        let offset = skip;
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, chunkSize, offset);
          if (bytesRead === 0) break;
          await sc.send(FrameType.CHUNK, {
            fileIndex: i,
            offset: BigInt(offset),
            data: buf.subarray(0, bytesRead),
          });
          offset += bytesRead;
          sent += bytesRead;
          opts.onProgress?.(sent, manifest.totalBytes);
        }
      } finally {
        await fh.close();
      }
    }

    await sc.send(FrameType.DONE, null);
    const { body: result } = await ch.withoutIdleTimeout(() => sc.recv([FrameType.RESULT]));
    if (!result.ok) {
      const reasons = result.failed.map((f) => `${f.path}: ${f.reason}`).join('; ');
      throw new TransferError('verify-failed', `server could not verify transfer: ${reasons}`);
    }
    return { files: manifest.files.map((f) => f.path), bytes: sent };
  } finally {
    ch.destroy();
  }
}
