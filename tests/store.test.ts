import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PartialStore } from '../src/store';
import { FileEntry, TransferError } from '../src/protocol';

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function entry(path: string, content: string): FileEntry {
  return { path, size: Buffer.byteLength(content), sha256: sha(content) };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(TransferError);
    expect((err as TransferError).code).toBe(code);
    return;
  }
  throw new Error(`expected TransferError ${code}, but nothing was thrown`);
}

describe('PartialStore', () => {
  test('prepare fresh reports zero received', async () => {
    const out = mkdtempSync(join(tmpdir(), 'es-store-'));
    const store = new PartialStore({ outDir: out });
    const received = await store.prepare([entry('a.txt', 'AAA')], []);
    expect(received).toEqual({ 'a.txt': 0 });
  });

  test('append enforces contiguity, bounds, and index', async () => {
    const out = mkdtempSync(join(tmpdir(), 'es-store-'));
    const store = new PartialStore({ outDir: out });
    await store.prepare([entry('a.txt', 'ABCDEF')], []);
    await store.append(0, 0n, Buffer.from('ABC'));
    await expectCode(store.append(0, 0n, Buffer.from('x')), 'non-contiguous');
    await expectCode(store.append(0, 3n, Buffer.from('DEFG')), 'overflow');
    await expectCode(store.append(5, 0n, Buffer.from('x')), 'bad-chunk');
    await store.append(0, 3n, Buffer.from('DEF'));
    expect(store.storedFiles()).toEqual([
      { entry: entry('a.txt', 'ABCDEF'), received: 6 },
    ]);
  });

  test('verifyAndLand lands files, dirs, and empty files atomically', async () => {
    const out = mkdtempSync(join(tmpdir(), 'es-store-'));
    const store = new PartialStore({ outDir: out });
    const files = [entry('a.txt', 'AAA'), entry('sub/b.txt', 'BBBB'), entry('empty.txt', '')];
    await store.prepare(files, ['sub', 'sub/empty']);
    await store.append(0, 0n, Buffer.from('AAA'));
    await store.append(1, 0n, Buffer.from('BB'));
    await store.append(1, 2n, Buffer.from('BB'));
    const result = await store.verifyAndLand();
    expect(result).toEqual({ ok: true, verified: ['a.txt', 'sub/b.txt', 'empty.txt'], failed: [] });
    expect(readFileSync(join(out, 'a.txt'), 'utf8')).toBe('AAA');
    expect(readFileSync(join(out, 'sub/b.txt'), 'utf8')).toBe('BBBB');
    expect(readFileSync(join(out, 'empty.txt'), 'utf8')).toBe('');
    expect(existsSync(join(out, 'sub/empty'))).toBe(true);
    expect(existsSync(join(out, '.es-partial'))).toBe(false);
  });

  test('checksum mismatch fails and resets for resend', async () => {
    const out = mkdtempSync(join(tmpdir(), 'es-store-'));
    const store = new PartialStore({ outDir: out });
    await store.prepare([entry('a.txt', 'RIGHT')], []);
    await store.append(0, 0n, Buffer.from('WRONG'));
    const result = await store.verifyAndLand();
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual([{ path: 'a.txt', reason: 'checksum mismatch' }]);
    expect(existsSync(join(out, 'a.txt'))).toBe(false);
    expect(store.storedFiles()[0].received).toBe(0);
  });

  test('incomplete files are reported, not landed', async () => {
    const out = mkdtempSync(join(tmpdir(), 'es-store-'));
    const store = new PartialStore({ outDir: out });
    await store.prepare([entry('a.txt', 'ABCDEF')], []);
    await store.append(0, 0n, Buffer.from('ABC'));
    const result = await store.verifyAndLand();
    expect(result.ok).toBe(false);
    expect(result.failed[0].reason).toMatch(/incomplete/);
    expect(existsSync(join(out, 'a.txt'))).toBe(false);
  });

  test('overwrite policy respected', async () => {
    const out = mkdtempSync(join(tmpdir(), 'es-store-'));
    writeFileSync(join(out, 'a.txt'), 'OLD');
    const noOver = new PartialStore({ outDir: out });
    await noOver.prepare([entry('a.txt', 'NEW')], []);
    await noOver.append(0, 0n, Buffer.from('NEW'));
    const refused = await noOver.verifyAndLand();
    expect(refused.ok).toBe(false);
    expect(refused.failed[0].reason).toMatch(/already exists/);
    expect(readFileSync(join(out, 'a.txt'), 'utf8')).toBe('OLD');

    const over = new PartialStore({ outDir: out, overwrite: true });
    const resumed = await over.prepare([entry('a.txt', 'NEW')], []);
    expect(resumed).toEqual({ 'a.txt': 3 });
    const landed = await over.verifyAndLand();
    expect(landed.ok).toBe(true);
    expect(readFileSync(join(out, 'a.txt'), 'utf8')).toBe('NEW');
  });

  test('resume state survives across store instances', async () => {
    const out = mkdtempSync(join(tmpdir(), 'es-store-'));
    const first = new PartialStore({ outDir: out });
    await first.prepare([entry('a.txt', '0123456789abcdef')], []);
    for (let i = 0; i < 8; i++) {
      await first.append(0, BigInt(i * 2), Buffer.from(String(i).repeat(2)));
    }
    const second = new PartialStore({ outDir: out });
    const received = await second.prepare([entry('a.txt', '0123456789abcdef')], []);
    expect(received).toEqual({ 'a.txt': 16 });
  });

  test('resume matches by path, not manifest order', async () => {
    const out = mkdtempSync(join(tmpdir(), 'es-store-'));
    const first = new PartialStore({ outDir: out });
    await first.prepare([entry('a.txt', 'AAAAAAAAAAAAAAAA'), entry('b.txt', 'B')], []);
    for (let i = 0; i < 8; i++) {
      await first.append(0, BigInt(i * 2), Buffer.from('AA'));
    }
    const second = new PartialStore({ outDir: out });
    const received = await second.prepare([entry('b.txt', 'B'), entry('a.txt', 'AAAAAAAAAAAAAAAA')], []);
    expect(received).toEqual({ 'b.txt': 0, 'a.txt': 16 });
  });

  test('changed content invalidates prior partial', async () => {
    const out = mkdtempSync(join(tmpdir(), 'es-store-'));
    const first = new PartialStore({ outDir: out });
    await first.prepare([entry('a.txt', 'AAAAAAAAAAAAAAAA')], []);
    for (let i = 0; i < 8; i++) {
      await first.append(0, BigInt(i * 2), Buffer.from('AA'));
    }
    const second = new PartialStore({ outDir: out });
    const received = await second.prepare([entry('a.txt', 'CHANGED!CHANGED!!')], []);
    expect(received).toEqual({ 'a.txt': 0 });
  });

  test('evil and duplicate paths rejected', async () => {
    const out = mkdtempSync(join(tmpdir(), 'es-store-'));
    const store = new PartialStore({ outDir: out });
    await expect(store.prepare([entry('../x', 'x')], [])).rejects.toThrow(TransferError);
    await expect(
      store.prepare([entry('a.txt', 'A'), entry('a.txt', 'B')], []),
    ).rejects.toThrow(/duplicate/);
  });
});
