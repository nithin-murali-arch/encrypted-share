import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'crypto';
import { createReadStream } from 'fs';
import { KEY_LENGTH, SALT_LENGTH, IV_BASE_LENGTH, TransferError } from './protocol';

const ALGORITHM = 'aes-256-gcm';

export function randomSalt(): Buffer {
  return randomBytes(SALT_LENGTH);
}

export function randomBaseNonce(): Buffer {
  return randomBytes(IV_BASE_LENGTH);
}

export function deriveKey(password: string | Buffer, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LENGTH, { N: 16384, r: 8, p: 1 });
}

export function sealChunk(
  key: Buffer,
  nonce: Buffer,
  plaintext: Buffer,
): { ciphertext: Buffer; tag: Buffer } {
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

export function openChunk(
  key: Buffer,
  nonce: Buffer,
  ciphertext: Buffer,
  tag: Buffer,
): Buffer {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, nonce);
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
