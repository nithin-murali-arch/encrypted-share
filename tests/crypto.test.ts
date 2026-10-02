import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  deriveKey,
  openChunk,
  randomBaseNonce,
  randomSalt,
  sealChunk,
  sha256File,
} from '../src/crypto';
import { deriveNonce, TransferError } from '../src/protocol';

describe('deriveKey', () => {
  test('deterministic, salt-sensitive, 32 bytes', () => {
    const salt = randomSalt();
    const k1 = deriveKey('password', salt);
    const k2 = deriveKey('password', salt);
    expect(k1.length).toBe(32);
    expect(k1.equals(k2)).toBe(true);
    expect(k1.equals(deriveKey('password', randomSalt()))).toBe(false);
    expect(k1.equals(deriveKey('other', salt))).toBe(false);
  });
});

describe('seal/open round-trip', () => {
  test('recovers plaintext including empty input', () => {
    const key = deriveKey('pw', randomSalt());
    const nonce = deriveNonce(randomBaseNonce(), 0n);
    for (const pt of [Buffer.from('hello world'), Buffer.alloc(0), Buffer.alloc(100000, 7)]) {
      const { ciphertext, tag } = sealChunk(key, nonce, pt);
      expect(tag.length).toBe(16);
      expect(openChunk(key, nonce, ciphertext, tag).equals(pt)).toBe(true);
    }
  });

  test('wrong key, wrong nonce, tampered bytes all fail', () => {
    const key = deriveKey('pw', randomSalt());
    const nonce = deriveNonce(randomBaseNonce(), 0n);
    const { ciphertext, tag } = sealChunk(key, nonce, Buffer.from('secret'));
    expect(() => openChunk(deriveKey('pw2', randomSalt()), nonce, ciphertext, tag)).toThrow(
      TransferError,
    );
    expect(() => openChunk(key, deriveNonce(randomBaseNonce(), 0n), ciphertext, tag)).toThrow(
      TransferError,
    );
    const badCt = Buffer.from(ciphertext);
    badCt[0] ^= 0xff;
    expect(() => openChunk(key, nonce, badCt, tag)).toThrow(TransferError);
    const badTag = Buffer.from(tag);
    badTag[0] ^= 0xff;
    expect(() => openChunk(key, nonce, ciphertext, badTag)).toThrow(TransferError);
  });
});

describe('random helpers', () => {
  test('lengths and uniqueness', () => {
    expect(randomSalt().length).toBe(16);
    expect(randomBaseNonce().length).toBe(4);
    expect(randomSalt().equals(randomSalt())).toBe(false);
  });
});

describe('sha256File', () => {
  test('matches known vector', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'es-hash-'));
    const f = join(dir, 'abc.txt');
    writeFileSync(f, 'abc');
    await expect(sha256File(f)).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('rejects on missing file', async () => {
    await expect(sha256File(join(tmpdir(), 'es-no-such-file-xyz'))).rejects.toThrow();
  });
});
