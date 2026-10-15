import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scryptSync } from 'crypto';
import { createReadStream } from 'fs';
import { KEY_LENGTH, SALT_LENGTH, SERVER_NONCE_LENGTH, TAG_LENGTH, TransferError } from './protocol';

const ALGORITHM = 'aes-256-gcm';

export interface SessionKeys {
  clientToServer: Buffer;
  serverToClient: Buffer;
}

export function randomSalt(): Buffer {
  return randomBytes(SALT_LENGTH);
}

export function randomServerNonce(): Buffer {
  return randomBytes(SERVER_NONCE_LENGTH);
}

export function deriveKey(password: string | Buffer, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LENGTH, { N: 16384, r: 8, p: 1 });
}

export function deriveSessionKeys(ikm: Buffer, clientSalt: Buffer, serverNonce: Buffer): SessionKeys {
  const salt = Buffer.concat([clientSalt, serverNonce]);
  const expand = (info: string): Buffer =>
    Buffer.from(hkdfSync('sha256', ikm, salt, info, KEY_LENGTH));
  return {
    clientToServer: expand('ES03 client->server'),
    serverToClient: expand('ES03 server->client'),
  };
}

export function sealChunk(
  key: Buffer,
  nonce: Buffer,
  plaintext: Buffer,
  aad?: Buffer,
): { ciphertext: Buffer; tag: Buffer } {
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

export function openChunk(
  key: Buffer,
  nonce: Buffer,
  ciphertext: Buffer,
  tag: Buffer,
  aad?: Buffer,
): Buffer {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_LENGTH });
    if (aad) decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new TransferError(
      'decrypt-failed',
      `chunk authentication failed: ${(err as Error).message}`,
    );
  }
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk as Buffer));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
