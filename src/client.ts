import { open } from 'fs/promises';
import { connect } from 'net';
import { join } from 'path';
import { SocketChannel } from './channel';
import { deriveKey, randomBaseNonce, randomSalt, sealChunk } from './crypto';
import { buildManifest, WarnFn } from './manifest';
import {
  decodeMessage,
  DEFAULT_CHUNK_SIZE,
  deriveNonce,
  encodeChunk,
  encodeHeader,
  MAX_CHUNK_BYTES,
  ResumeMessage,
  ResultMessage,
  TransferError,
  TransferHeader,
} from './protocol';

export interface SendOptions {
  host: string;
  port: number;
  password: string | Buffer;
  path: string;
  chunkSize?: number;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  onWarn?: WarnFn;
}

export interface SendReport {
  files: string[];
  bytes: number;
}

export async function sendFiles(opts: SendOptions): Promise<SendReport> {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize > MAX_CHUNK_BYTES) {
    throw new TransferError('bad-config', `invalid chunk size: ${chunkSize}`);
  }
  const manifest = await buildManifest(opts.path, opts.onWarn);
  const salt = randomSalt();
  const baseNonce = randomBaseNonce();
  const key = deriveKey(opts.password, salt);

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

  const ch = new SocketChannel(socket);
  try {
    const header: TransferHeader = {
      salt: salt.toString('base64'),
      baseNonce: baseNonce.toString('base64'),
      chunkSize,
      files: manifest.files,
      dirs: manifest.dirs,
    };
    await ch.write(encodeHeader(header));
    const resume = decodeMessage<ResumeMessage>(await ch.readFrame());
    if (resume.error) {
      throw new TransferError('rejected', `server rejected transfer: ${resume.error}`);
    }

    let counter = 0n;
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
          const plaintext = buf.subarray(0, bytesRead);
          const { ciphertext, tag } = sealChunk(key, deriveNonce(baseNonce, counter), plaintext);
          counter += 1n;
          await ch.write(encodeChunk(i, BigInt(offset), ciphertext, tag));
          offset += bytesRead;
          sent += bytesRead;
          opts.onProgress?.(sent, manifest.totalBytes);
        }
      } finally {
        await fh.close();
      }
    }

    await ch.write(Buffer.alloc(4));
    const result = decodeMessage<ResultMessage>(await ch.readFrame());
    if (!result.ok) {
      const reasons = result.failed.map((f) => `${f.path}: ${f.reason}`).join('; ');
      throw new TransferError('verify-failed', `server could not verify transfer: ${reasons}`);
    }
    return { files: manifest.files.map((f) => f.path), bytes: sent };
  } finally {
    ch.destroy();
  }
}
