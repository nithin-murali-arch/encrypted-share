import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  deriveKey,
  deriveSessionKeys,
  openChunk,
  randomSalt,
  randomServerNonce,
  sealChunk,
  sha256File,
} from '../src/crypto';
import { TransferError } from '../src/protocol';

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

describe('deriveSessionKeys', () => {
  const ikm = Buffer.alloc(32, 1);
  const clientSalt = Buffer.alloc(16, 2);

  test('matches an independent HKDF-SHA256 computation, one key per direction', () => {
    const keys = deriveSessionKeys(ikm, clientSalt, Buffer.alloc(16, 3));
    expect(keys.clientToServer.toString('hex')).toBe(
      '3ba88d127271968bd6cc8f260da6bf85135e6060162d92bf5955fcbc81a10e6f',
    );
    expect(keys.serverToClient.toString('hex')).toBe(
      'aaf72933f5a66d3be6101d59ace5f08af622b21a84fb44c5498a9a1bedd6b31f',
    );
  });

  test('a different server nonce gives different keys', () => {
    const keys = deriveSessionKeys(ikm, clientSalt, Buffer.alloc(16, 4));
    expect(keys.clientToServer.toString('hex')).toBe(
      '33def2cfe610e80e308677368978c33794dacd1f83da96981daabc65b851ef2c',
    );
    expect(keys.serverToClient.toString('hex')).toBe(
      '000e1cf9b8a9c692d38bf2f12a1885ee0f1ccf08f7c0f9d48c7534c1bf078ea2',
    );
  });
});

describe('seal/open round-trip', () => {
  const nonce = Buffer.alloc(12, 5);

  test('recovers plaintext including empty input', () => {
    const key = deriveKey('pw', randomSalt());
    for (const pt of [Buffer.from('hello world'), Buffer.alloc(0), Buffer.alloc(100000, 7)]) {
      const { ciphertext, tag } = sealChunk(key, nonce, pt);
      expect(tag.length).toBe(16);
      expect(openChunk(key, nonce, ciphertext, tag).equals(pt)).toBe(true);
    }
  });

  test('wrong key, wrong nonce, tampered bytes, truncated tag all fail', () => {
    const key = deriveKey('pw', randomSalt());
    const { ciphertext, tag } = sealChunk(key, nonce, Buffer.from('secret'));
    expect(() => openChunk(deriveKey('pw2', randomSalt()), nonce, ciphertext, tag)).toThrow(
      TransferError,
    );
    expect(() => openChunk(key, Buffer.alloc(12, 6), ciphertext, tag)).toThrow(TransferError);
    const badCt = Buffer.from(ciphertext);
    badCt[0] ^= 0xff;
    expect(() => openChunk(key, nonce, badCt, tag)).toThrow(TransferError);
    const badTag = Buffer.from(tag);
    badTag[0] ^= 0xff;
    expect(() => openChunk(key, nonce, ciphertext, badTag)).toThrow(TransferError);
    expect(() => openChunk(key, nonce, ciphertext, tag.subarray(0, 4))).toThrow(TransferError);
  });

  test('associated data must match', () => {
    const key = deriveKey('pw', randomSalt());
    const aad = Buffer.from('ES03');
    const { ciphertext, tag } = sealChunk(key, nonce, Buffer.from('secret'), aad);
    expect(openChunk(key, nonce, ciphertext, tag, aad).toString()).toBe('secret');
    expect(() => openChunk(key, nonce, ciphertext, tag)).toThrow(TransferError);
    expect(() => openChunk(key, nonce, ciphertext, tag, Buffer.from('ES02'))).toThrow(TransferError);
  });
});

describe('random helpers', () => {
  test('lengths and uniqueness', () => {
    expect(randomSalt().length).toBe(16);
    expect(randomServerNonce().length).toBe(16);
    expect(randomSalt().equals(randomSalt())).toBe(false);
    expect(randomServerNonce().equals(randomServerNonce())).toBe(false);
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
